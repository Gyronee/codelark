import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './manager.js';
import { Database } from './db.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/remote-control-session-test.db';

describe('SessionManager', () => {
  let db: Database;
  let sm: SessionManager;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
    sm = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('creates a new session when none exists', () => {
    const session = sm.getOrCreate('ou_1', null, 'my-app');
    expect(session.id).toBeTruthy();
    expect(session.claude_session_id).toBeNull();
  });

  it('reuses existing session', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'my-app');
    const s2 = sm.getOrCreate('ou_1', null, 'my-app');
    expect(s1.id).toBe(s2.id);
  });

  it('separates sessions by topic', () => {
    const s1 = sm.getOrCreate('ou_1', 'topic_a', 'my-app');
    const s2 = sm.getOrCreate('ou_1', 'topic_b', 'my-app');
    expect(s1.id).not.toBe(s2.id);
  });

  it('separates sessions by project', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'app-a');
    const s2 = sm.getOrCreate('ou_1', null, 'app-b');
    expect(s1.id).not.toBe(s2.id);
  });

  it('resets a session', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'my-app');
    db.updateClaudeSessionId(s1.id, 'claude-abc');
    sm.reset('ou_1', null, 'my-app');
    const s2 = sm.getOrCreate('ou_1', null, 'my-app');
    expect(s2.claude_session_id).toBeNull();
  });

  describe('active tasks', () => {
    it('tracks active task per user', () => {
      expect(sm.hasActiveTask('ou_1')).toBe(false);
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      expect(sm.hasActiveTask('ou_1')).toBe(true);
    });

    it('cancels active task', () => {
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      sm.cancelTask('ou_1');
      expect(controller.signal.aborted).toBe(true);
      expect(sm.hasActiveTask('ou_1')).toBe(false);
    });

    it('clears active task', () => {
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      sm.clearActiveTask('ou_1');
      expect(sm.hasActiveTask('ou_1')).toBe(false);
    });
  });
});
