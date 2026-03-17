import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/remote-control-test.db';

describe('Database', () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  describe('users', () => {
    it('upserts and retrieves a user', () => {
      db.upsertUser('ou_123', 'Alice');
      const user = db.getUser('ou_123');
      expect(user).toMatchObject({ feishu_user_id: 'ou_123', name: 'Alice' });
    });

    it('sets active project', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setActiveProject('ou_123', 'my-app');
      const user = db.getUser('ou_123');
      expect(user?.active_project).toBe('my-app');
    });
  });

  describe('sessions', () => {
    it('creates and finds session by user + project', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.id).toBe(id);
    });

    it('finds session by user + topic + project', () => {
      const id = db.createSession('ou_123', 'topic_1', 'my-app');
      const session = db.findSession('ou_123', 'topic_1', 'my-app');
      expect(session?.id).toBe(id);
    });

    it('returns null for non-existent session', () => {
      const session = db.findSession('ou_999', null, 'no-project');
      expect(session).toBeNull();
    });

    it('updates claude session id', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.updateClaudeSessionId(id, 'claude-session-abc');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.claude_session_id).toBe('claude-session-abc');
    });

    it('resets session by clearing claude_session_id', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.updateClaudeSessionId(id, 'claude-session-abc');
      db.resetSession(id);
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.claude_session_id).toBeNull();
    });
  });

  describe('task logs', () => {
    it('logs a task', () => {
      const sessionId = db.createSession('ou_123', null, 'my-app');
      db.logTask(sessionId, 'fix the bug', 'done', '["Read","Edit"]', 1234, 'success');
      const logs = db.getTaskLogs(sessionId, 5);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        user_message: 'fix the bug',
        status: 'success',
      });
    });
  });
});
