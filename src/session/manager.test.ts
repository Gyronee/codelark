import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from './manager.js';
import { Database } from './db.js';
import { existsSync, unlinkSync } from 'fs';

// Mock forkSession from SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: vi.fn().mockResolvedValue({ sessionId: 'forked-session-uuid' }),
}));

const TEST_DB = '/tmp/codelark-session-test.db';

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

  describe('fork', () => {
    it('creates a new session with forked claude_session_id', async () => {
      // Create original session with a claude_session_id
      const original = sm.getOrCreate('user1', null, 'project1');
      db.updateClaudeSessionId(original.id, 'original-claude-id');

      const forked = await sm.fork('user1', null, 'project1', 'original-claude-id', '/path/to/project', 'Fork title');

      expect(forked.claude_session_id).toBe('forked-session-uuid');
      expect(forked.title).toBe('Fork title');
      expect(forked.id).not.toBe(original.id);

      // Forked session should appear in the session list
      const all = sm.listAll('user1', null, 'project1');
      expect(all.some(s => s.id === forked.id)).toBe(true);
      expect(all).toHaveLength(2);
    });

    it('fork without title sets title to null', async () => {
      const original = sm.getOrCreate('user1', null, 'project1');
      db.updateClaudeSessionId(original.id, 'original-claude-id');

      const forked = await sm.fork('user1', null, 'project1', 'original-claude-id', '/path/to/project');
      expect(forked.title).toBeNull();
    });
  });

  describe('listAll', () => {
    it('returns all sessions for a composite key', () => {
      sm.getOrCreate('user1', null, 'project1');
      sm.getOrCreate('user1', null, 'project1'); // same composite key, but getOrCreate returns existing
      // Create a second session by direct DB insert
      db.createSession('user1', null, 'project1');
      const sessions = sm.listAll('user1', null, 'project1');
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });
  });

});
