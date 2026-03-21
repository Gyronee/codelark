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

  it('getOrCreateGroup creates and retrieves a group session', () => {
    const session = sm.getOrCreateGroup('chat_1', null, 'group-proj');
    expect(session.id).toBeTruthy();
    expect(session.feishu_user_id).toBe('group:chat_1');
    expect(session.project_name).toBe('group-proj');
    expect(session.claude_session_id).toBeNull();
  });

  it('getOrCreateGroup returns same session on second call', () => {
    const s1 = sm.getOrCreateGroup('chat_1', 'thread_a', 'group-proj');
    const s2 = sm.getOrCreateGroup('chat_1', 'thread_a', 'group-proj');
    expect(s1.id).toBe(s2.id);
  });

  it('resetGroup clears claude_session_id', () => {
    const s1 = sm.getOrCreateGroup('chat_1', null, 'group-proj');
    db.updateClaudeSessionId(s1.id, 'claude-xyz');
    sm.resetGroup('chat_1', null, 'group-proj');
    const s2 = sm.getOrCreateGroup('chat_1', null, 'group-proj');
    expect(s2.claude_session_id).toBeNull();
  });

});
