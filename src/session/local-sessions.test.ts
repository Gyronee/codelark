import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listLocalSessions,
  findSessionById,
  getRecentMessages,
  setClaudeDir,
  getClaudeDir,
} from './local-sessions.js';

const TEST_DIR = path.join(os.tmpdir(), 'local-sessions-test-' + process.pid);
let originalDir: string;

function writeJsonl(filePath: string, entries: object[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
}

function writeSessionJson(pid: number, sessionId: string, cwd: string): void {
  const sessionsDir = path.join(TEST_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() }),
  );
}

describe('local-sessions', () => {
  beforeEach(() => {
    originalDir = getClaudeDir();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setClaudeDir(TEST_DIR);
  });

  afterEach(() => {
    setClaudeDir(originalDir);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('listLocalSessions', () => {
    it('finds sessions from JSONL files, extracts cwd from content, sorts by mtime', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-project-alpha');
      const sid1 = 'aaaaaaaa-1111-2222-3333-444444444444';
      const sid2 = 'bbbbbbbb-1111-2222-3333-444444444444';

      // Write first session
      writeJsonl(path.join(projDir, `${sid1}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid1,
          cwd: '/Users/test/project-alpha',
          message: { role: 'user', content: 'Hello world' },
          uuid: 'u1',
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: sid1,
          cwd: '/Users/test/project-alpha',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
          uuid: 'u2',
        },
      ]);

      // Write second session (touch it to be newer)
      writeJsonl(path.join(projDir, `${sid2}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid2,
          cwd: '/Users/test/project-beta',
          message: { role: 'user', content: 'Build the feature' },
          uuid: 'u3',
        },
      ]);

      // Make sid2 newer by touching it
      const now = Date.now();
      fs.utimesSync(path.join(projDir, `${sid1}.jsonl`), new Date(now - 5000), new Date(now - 5000));
      fs.utimesSync(path.join(projDir, `${sid2}.jsonl`), new Date(now), new Date(now));

      const sessions = listLocalSessions();

      expect(sessions).toHaveLength(2);
      // Sorted by mtime descending: sid2 first
      expect(sessions[0].sessionId).toBe(sid2);
      expect(sessions[0].cwd).toBe('/Users/test/project-beta');
      expect(sessions[0].projectName).toBe('project-beta');
      expect(sessions[0].summary).toBe('Build the feature');
      expect(sessions[0].isActive).toBe(false);

      expect(sessions[1].sessionId).toBe(sid1);
      expect(sessions[1].cwd).toBe('/Users/test/project-alpha');
      expect(sessions[1].projectName).toBe('project-alpha');
    });

    it('returns empty array if dir does not exist', () => {
      setClaudeDir('/tmp/nonexistent-local-sessions-test-dir');
      const sessions = listLocalSessions();
      expect(sessions).toEqual([]);
    });

    it('marks sessions as active when PID is alive', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = 'cccccccc-1111-2222-3333-444444444444';

      writeJsonl(path.join(projDir, `${sid}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Test' },
          uuid: 'u1',
        },
      ]);

      // Use current process PID (which is alive)
      writeSessionJson(process.pid, sid, '/Users/test/proj');

      const sessions = listLocalSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].isActive).toBe(true);
      expect(sessions[0].activePid).toBe(process.pid);
    });

    it('respects limit parameter', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      for (let i = 0; i < 5; i++) {
        const sid = `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`;
        writeJsonl(path.join(projDir, `${sid}.jsonl`), [
          {
            type: 'user',
            isSidechain: false,
            sessionId: sid,
            cwd: `/Users/test/proj${i}`,
            message: { role: 'user', content: `Message ${i}` },
            uuid: `u${i}`,
          },
        ]);
      }

      const sessions = listLocalSessions(2);
      expect(sessions).toHaveLength(2);
    });
  });

  describe('getRecentMessages', () => {
    it('reads user/assistant messages from tail', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = 'dddddddd-1111-2222-3333-444444444444';

      writeJsonl(path.join(projDir, `${sid}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'First question' },
          uuid: 'u1',
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
          uuid: 'u2',
        },
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Second question' },
          uuid: 'u3',
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
          uuid: 'u4',
        },
      ]);

      const messages = getRecentMessages(sid);
      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ role: 'user', text: 'First question' });
      expect(messages[1]).toEqual({ role: 'assistant', text: 'First answer' });
      expect(messages[2]).toEqual({ role: 'user', text: 'Second question' });
      expect(messages[3]).toEqual({ role: 'assistant', text: 'Second answer' });
    });

    it('handles truncated first line', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = 'eeeeeeee-1111-2222-3333-444444444444';

      // Create a file with a large first entry that will be truncated when reading tail
      const longContent = 'x'.repeat(40000);
      const entries = [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: longContent },
          uuid: 'u1',
        },
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Visible message' },
          uuid: 'u2',
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Visible reply' }] },
          uuid: 'u3',
        },
      ];

      const filePath = path.join(projDir, `${sid}.jsonl`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      // Reading last 32KB should truncate the first huge line
      const messages = getRecentMessages(sid);
      expect(messages.length).toBeGreaterThanOrEqual(1);
      // The visible messages should be present
      const userMsg = messages.find(m => m.text === 'Visible message');
      expect(userMsg).toBeDefined();
      const assistantMsg = messages.find(m => m.text === 'Visible reply');
      expect(assistantMsg).toBeDefined();
    });

    it('skips sidechain messages', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = 'ffffffff-1111-2222-3333-444444444444';

      writeJsonl(path.join(projDir, `${sid}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Main message' },
          uuid: 'u1',
        },
        {
          type: 'user',
          isSidechain: true,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Sidechain message' },
          uuid: 'u2',
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Main reply' }] },
          uuid: 'u3',
        },
      ]);

      const messages = getRecentMessages(sid);
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('Main message');
      expect(messages[1].text).toBe('Main reply');
    });

    it('truncates long messages to 200 chars', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = '11111111-1111-2222-3333-444444444444';
      const longMsg = 'a'.repeat(300);

      writeJsonl(path.join(projDir, `${sid}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: longMsg },
          uuid: 'u1',
        },
      ]);

      const messages = getRecentMessages(sid);
      expect(messages).toHaveLength(1);
      expect(messages[0].text.length).toBe(203); // 200 + '...'
    });

    it('returns empty for nonexistent session', () => {
      const messages = getRecentMessages('nonexistent-session-id');
      expect(messages).toEqual([]);
    });
  });

  describe('findSessionById', () => {
    it('prefix match works', () => {
      const projDir = path.join(TEST_DIR, 'projects', '-Users-test-proj');
      const sid = '22222222-aaaa-bbbb-cccc-dddddddddddd';

      writeJsonl(path.join(projDir, `${sid}.jsonl`), [
        {
          type: 'user',
          isSidechain: false,
          sessionId: sid,
          cwd: '/Users/test/proj',
          message: { role: 'user', content: 'Hello' },
          uuid: 'u1',
        },
      ]);

      const found = findSessionById('22222222');
      expect(found).not.toBeNull();
      expect(found!.sessionId).toBe(sid);
      expect(found!.cwd).toBe('/Users/test/proj');
    });

    it('returns null for no match', () => {
      const found = findSessionById('zzzzzzz-no-match');
      expect(found).toBeNull();
    });
  });
});
