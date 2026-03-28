import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database, OAuthToken } from './db.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/codelark-test.db';

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

    it('setActiveProjectWithCwd stores project and cwd', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setActiveProjectWithCwd('ou_123', 'my-app', '/home/user/my-app');
      const user = db.getUser('ou_123');
      expect(user?.active_project).toBe('my-app');
      expect(user?.active_cwd).toBe('/home/user/my-app');
    });

    it('setActiveProject clears active_cwd', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setActiveProjectWithCwd('ou_123', 'my-app', '/home/user/my-app');
      db.setActiveProject('ou_123', 'other-project');
      const user = db.getUser('ou_123');
      expect(user?.active_project).toBe('other-project');
      expect(user?.active_cwd).toBeNull();
    });

    it('setActiveProject(null) clears active_cwd', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setActiveProjectWithCwd('ou_123', 'my-app', '/home/user/my-app');
      db.setActiveProject('ou_123', null);
      const user = db.getUser('ou_123');
      expect(user?.active_project).toBeNull();
      expect(user?.active_cwd).toBeNull();
    });

    it('setResumedSession stores session id and cwd', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setResumedSession('ou_123', 'session-xyz', '/home/user/project');
      const user = db.getUser('ou_123');
      expect(user?.resumed_session_id).toBe('session-xyz');
      expect(user?.resumed_cwd).toBe('/home/user/project');
    });

    it('clearResumedSession sets fields to null', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setResumedSession('ou_123', 'session-xyz', '/home/user/project');
      db.clearResumedSession('ou_123');
      const user = db.getUser('ou_123');
      expect(user?.resumed_session_id).toBeNull();
      expect(user?.resumed_cwd).toBeNull();
    });

    it('setResumedSession twice overwrites previous values', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setResumedSession('ou_123', 'session-first', '/first/path');
      db.setResumedSession('ou_123', 'session-second', '/second/path');
      const user = db.getUser('ou_123');
      expect(user?.resumed_session_id).toBe('session-second');
      expect(user?.resumed_cwd).toBe('/second/path');
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

    it('setSessionModel stores model on session', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.setSessionModel(id, 'claude-sonnet-4-6');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.model).toBe('claude-sonnet-4-6');
    });

    it('setSessionModel overwrites previous model', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.setSessionModel(id, 'claude-sonnet-4-6');
      db.setSessionModel(id, 'claude-opus-4-6');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.model).toBe('claude-opus-4-6');
    });

    it('new session has null model by default', () => {
      db.createSession('ou_123', null, 'my-app');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.model).toBeNull();
    });
  });

  describe('oauth tokens', () => {
    const token: OAuthToken = {
      accessToken: 'u-abc123',
      refreshToken: 'ur-refresh456',
      expiresAt: 1700000000000,
      refreshExpiresAt: 1700086400000,
      scope: 'contact:user.base:readonly',
      grantedAt: 1699999000000,
    };

    it('saveToken + getToken round-trip', () => {
      db.saveToken('ou_100', token);
      const result = db.getToken('ou_100');
      expect(result).toEqual(token);
    });

    it('getToken returns null when no token', () => {
      expect(db.getToken('ou_nonexistent')).toBeNull();
    });

    it('deleteToken removes the token', () => {
      db.saveToken('ou_100', token);
      db.deleteToken('ou_100');
      expect(db.getToken('ou_100')).toBeNull();
    });

    it('saveToken twice upserts (replaces)', () => {
      db.saveToken('ou_100', token);
      const updated: OAuthToken = {
        ...token,
        accessToken: 'u-new-token',
        expiresAt: 1800000000000,
      };
      db.saveToken('ou_100', updated);
      const result = db.getToken('ou_100');
      expect(result).toEqual(updated);
    });

    it('all fields are correctly stored and retrieved', () => {
      db.saveToken('ou_200', token);
      const result = db.getToken('ou_200')!;
      expect(result.accessToken).toBe('u-abc123');
      expect(result.refreshToken).toBe('ur-refresh456');
      expect(result.expiresAt).toBe(1700000000000);
      expect(result.refreshExpiresAt).toBe(1700086400000);
      expect(result.scope).toBe('contact:user.base:readonly');
      expect(result.grantedAt).toBe(1699999000000);
    });
  });

  describe('thread_bindings', () => {
    it('ensureThreadCreator + getThreadBinding returns creator with null project', () => {
      db.ensureThreadCreator('chat_1', 'thread_1', 'ou_alice');
      const binding = db.getThreadBinding('chat_1', 'thread_1');
      expect(binding).toEqual({ projectName: null, creatorUserId: 'ou_alice' });
    });

    it('ensureThreadCreator twice is idempotent, keeps first creator', () => {
      db.ensureThreadCreator('chat_1', 'thread_1', 'ou_alice');
      db.ensureThreadCreator('chat_1', 'thread_1', 'ou_bob');
      const binding = db.getThreadBinding('chat_1', 'thread_1');
      expect(binding?.creatorUserId).toBe('ou_alice');
    });

    it('setThreadBinding after ensureThreadCreator returns true and sets project', () => {
      db.ensureThreadCreator('chat_1', 'thread_1', 'ou_alice');
      const result = db.setThreadBinding('chat_1', 'thread_1', 'my-app', 'ou_alice');
      expect(result).toBe(true);
      const binding = db.getThreadBinding('chat_1', 'thread_1');
      expect(binding?.projectName).toBe('my-app');
      expect(binding?.creatorUserId).toBe('ou_alice');
    });

    it('setThreadBinding twice returns false (already bound)', () => {
      db.ensureThreadCreator('chat_1', 'thread_1', 'ou_alice');
      db.setThreadBinding('chat_1', 'thread_1', 'my-app', 'ou_alice');
      const result = db.setThreadBinding('chat_1', 'thread_1', 'other-app', 'ou_alice');
      expect(result).toBe(false);
      const binding = db.getThreadBinding('chat_1', 'thread_1');
      expect(binding?.projectName).toBe('my-app');
    });

    it('setThreadBinding without prior ensureThreadCreator inserts full row', () => {
      const result = db.setThreadBinding('chat_2', 'thread_2', 'my-app', 'ou_bob');
      expect(result).toBe(true);
      const binding = db.getThreadBinding('chat_2', 'thread_2');
      expect(binding?.projectName).toBe('my-app');
      expect(binding?.creatorUserId).toBe('ou_bob');
    });

    it('getThreadBinding for nonexistent returns null', () => {
      const binding = db.getThreadBinding('chat_999', 'thread_999');
      expect(binding).toBeNull();
    });
  });

  describe('title column', () => {
    it('SessionRow should have title field after migration', () => {
      const id = db.createSession('user1', null, 'project1');
      const session = db.findSession('user1', null, 'project1');
      expect(session).not.toBeNull();
      expect(session!.title).toBeNull();
    });

    it('setSessionTitle updates the title', () => {
      const id = db.createSession('user1', null, 'project1');
      db.setSessionTitle(id, 'My Session');
      const session = db.findSession('user1', null, 'project1');
      expect(session!.title).toBe('My Session');
    });
  });

  describe('listSessions', () => {
    it('returns all sessions for a (userId, topicId, projectName) combo', () => {
      db.createSession('user1', null, 'project1');
      db.createSession('user1', null, 'project1');
      db.createSession('user1', null, 'other-project');
      const sessions = db.listSessions('user1', null, 'project1');
      expect(sessions).toHaveLength(2);
    });

    it('orders by last_active_at DESC', () => {
      const id1 = db.createSession('user1', null, 'project1');
      const id2 = db.createSession('user1', null, 'project1');
      db.touchSession(id1); // make id1 most recent
      const sessions = db.listSessions('user1', null, 'project1');
      expect(sessions[0].id).toBe(id1);
      expect(sessions[1].id).toBe(id2);
    });

    it('respects topicId', () => {
      db.createSession('user1', 'topic1', 'project1');
      db.createSession('user1', null, 'project1');
      const sessions = db.listSessions('user1', 'topic1', 'project1');
      expect(sessions).toHaveLength(1);
    });
  });

  describe('findBotSessionByIdPrefix', () => {
    it('finds session by ID prefix', () => {
      const id = db.createSession('user1', null, 'project1');
      const found = db.findBotSessionByIdPrefix(id.slice(0, 8));
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('returns null for non-matching prefix', () => {
      db.createSession('user1', null, 'project1');
      const found = db.findBotSessionByIdPrefix('xxxxxxxx');
      expect(found).toBeNull();
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
