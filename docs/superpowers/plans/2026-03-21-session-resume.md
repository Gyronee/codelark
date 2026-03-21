# Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users list and resume local Claude Code CLI sessions through the Feishu bot, with recent message preview.

**Architecture:** A new `local-sessions.ts` module scans `~/.claude/projects/` and `~/.claude/sessions/` to discover CLI sessions. `/session list` shows recent sessions as a Feishu card. `/session resume <id>` stores the CLI session's ID and cwd in the users table, and subsequent messages use the existing V1 `query({ resume })` path with that session's cwd. No new execution path — fully reuses existing streaming card, permissions, and tool infrastructure.

**Tech Stack:** Node.js `fs` (read-only access to `~/.claude/`), `better-sqlite3`, existing `@anthropic-ai/claude-agent-sdk` V1 API

---

### Task 1: Add resumed session fields to users table

**Files:**
- Modify: `src/session/db.ts`
- Test: `src/session/db.test.ts`

- [ ] **Step 1: Write tests for resumed session DB methods**

Test cases:
1. `setResumedSession(userId, sessionId, cwd)` + `getUser(userId)` → user has `resumed_session_id` and `resumed_cwd`
2. `clearResumedSession(userId)` → both fields become null
3. `setResumedSession` twice → overwrites previous values

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/db.test.ts`

- [ ] **Step 3: Add migration and methods**

In `migrate()`, add:
```sql
ALTER TABLE users ADD COLUMN resumed_session_id TEXT;
ALTER TABLE users ADD COLUMN resumed_cwd TEXT;
```
Wrap each ALTER in try/catch (column may already exist on re-run).

Add methods:
```typescript
setResumedSession(feishuUserId: string, sessionId: string, cwd: string): void {
  this.db.prepare('UPDATE users SET resumed_session_id = ?, resumed_cwd = ? WHERE feishu_user_id = ?')
    .run(sessionId, cwd, feishuUserId);
}

clearResumedSession(feishuUserId: string): void {
  this.db.prepare('UPDATE users SET resumed_session_id = NULL, resumed_cwd = NULL WHERE feishu_user_id = ?')
    .run(feishuUserId);
}
```

Update `UserRow` type to include `resumed_session_id: string | null` and `resumed_cwd: string | null`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/session/db.ts src/session/db.test.ts
git commit -m "feat: add resumed_session_id and resumed_cwd to users table"
```

---

### Task 2: Create local-sessions module

**Files:**
- Create: `src/session/local-sessions.ts`
- Test: `src/session/local-sessions.test.ts`

- [ ] **Step 1: Write tests**

Use a temp directory to simulate `~/.claude/` structure. Test cases:
1. `listLocalSessions` — discovers sessions from JSONL files, returns sorted by mtime
2. `listLocalSessions` — marks active sessions (matching PID in sessions/*.json with live process)
3. `listLocalSessions` — gracefully returns empty array if `~/.claude/` doesn't exist
4. `getRecentMessages` — reads last N user/assistant messages from JSONL file
5. `getRecentMessages` — handles truncated first line (partial read from tail)
6. `findSessionById` — finds session by prefix match (first 8 chars)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/local-sessions.test.ts`

- [ ] **Step 3: Implement local-sessions.ts**

```typescript
import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, basename, sep } from 'path';
import { homedir } from 'os';
import { logger } from '../logger.js';

export interface LocalSession {
  sessionId: string;
  cwd: string;
  projectName: string;   // last segment of cwd (e.g., "remote-control")
  summary: string;        // firstPrompt or sessionId prefix
  lastModified: number;   // Unix ms (from file mtime)
  isActive: boolean;
  activePid?: number;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  text: string;
}

const CLAUDE_DIR = join(homedir(), '.claude');
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const TAIL_BYTES = 8192; // Read last 8KB for metadata/messages

export function listLocalSessions(limit = 15): LocalSession[] {
  if (!existsSync(PROJECTS_DIR)) return [];

  const activeSessions = loadActiveSessions();
  const sessions: LocalSession[] = [];

  try {
    for (const projectDir of readdirSync(PROJECTS_DIR)) {
      const projectPath = join(PROJECTS_DIR, projectDir);
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) continue;

      // Decode project dir name back to cwd
      // e.g., "-Users-gyronee-Developer-remote-control" → "/Users/gyronee/Developer/remote-control"
      const cwd = decodeCwd(projectDir);
      const projectName = cwd.split(sep).pop() || projectDir;

      try {
        for (const file of readdirSync(projectPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = file.replace('.jsonl', '');
          // Skip non-UUID files (e.g., memory files)
          if (sessionId.length < 36) continue;

          const filePath = join(projectPath, file);
          const fileStat = statSync(filePath);

          // Read tail for summary
          const tailLines = readTail(filePath, TAIL_BYTES);
          const summary = extractSummary(tailLines, sessionId);

          const activeInfo = activeSessions.get(sessionId);

          sessions.push({
            sessionId,
            cwd,
            projectName,
            summary,
            lastModified: fileStat.mtimeMs,
            isActive: activeInfo?.active ?? false,
            activePid: activeInfo?.pid,
          });
        }
      } catch { /* skip unreadable project dirs */ }
    }
  } catch { /* PROJECTS_DIR unreadable */ }

  // Sort by most recent first, take limit
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions.slice(0, limit);
}

export function findSessionById(idPrefix: string): LocalSession | null {
  const all = listLocalSessions(50);
  return all.find(s => s.sessionId.startsWith(idPrefix)) ?? null;
}

export function getRecentMessages(sessionId: string, count = 5): RecentMessage[] {
  // Find the JSONL file
  const filePath = findSessionFile(sessionId);
  if (!filePath) return [];

  const tailLines = readTail(filePath, 32768); // 32KB for message content
  const messages: RecentMessage[] = [];

  for (const line of tailLines.reverse()) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.role === 'user') {
        const content = entry.message.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
        if (text && !entry.isSidechain) {
          messages.push({ role: 'user', text: text.slice(0, 200) });
        }
      } else if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
        const content = entry.message.content;
        const text = Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
        if (text && !entry.isSidechain) {
          messages.push({ role: 'assistant', text: text.slice(0, 200) });
        }
      }
    } catch { /* skip malformed lines */ }
    if (messages.length >= count) break;
  }

  return messages.reverse(); // chronological order
}

// --- Helpers ---

function decodeCwd(encoded: string): string {
  // "-Users-gyronee-Developer-remote-control" → "/Users/gyronee/Developer/remote-control"
  // First char is always "-" representing the leading "/"
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function readTail(filePath: string, bytes: number): string[] {
  const stat = statSync(filePath);
  const readSize = Math.min(bytes, stat.size);
  const buffer = Buffer.alloc(readSize);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf-8').split('\n').filter(l => l.trim());
  // Discard first line (may be truncated)
  if (stat.size > readSize && lines.length > 0) {
    lines.shift();
  }
  return lines;
}

function extractSummary(lines: string[], sessionId: string): string {
  // Try to find firstPrompt from early entries, or use last user message
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.role === 'user' && !entry.isSidechain) {
        const content = entry.message.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
        if (text) return text.slice(0, 80);
      }
    } catch { /* skip */ }
  }
  return sessionId.slice(0, 8);
}

function findSessionFile(sessionId: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  try {
    for (const projectDir of readdirSync(PROJECTS_DIR)) {
      const filePath = join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
      if (existsSync(filePath)) return filePath;
    }
  } catch { /* ignore */ }
  return null;
}

function loadActiveSessions(): Map<string, { active: boolean; pid: number }> {
  const result = new Map<string, { active: boolean; pid: number }>();
  if (!existsSync(SESSIONS_DIR)) return result;

  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
        if (data.sessionId && data.pid) {
          // Check if process is still alive
          let alive = false;
          try { process.kill(data.pid, 0); alive = true; } catch { /* not alive */ }
          result.set(data.sessionId, { active: alive, pid: data.pid });
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/session/local-sessions.ts src/session/local-sessions.test.ts
git commit -m "feat: add local-sessions module for discovering CLI sessions"
```

---

### Task 3: Add /session command parsing

**Files:**
- Modify: `src/utils/command.ts`
- Test: `src/utils/command.test.ts`

- [ ] **Step 1: Write tests**

Test cases:
1. `/session list` → `{ type: 'session', action: 'list', args: [] }`
2. `/session resume ff48c101` → `{ type: 'session', action: 'resume', args: ['ff48c101'] }`
3. `/session` (bare) → `{ type: 'session', action: 'list', args: [] }` (default to list)

- [ ] **Step 2: Implement**

Add `'session'` to `ParsedCommand.type` union. Add case in `parseCommand`:

```typescript
case '/session': {
  const action = parts[1] || null;
  if (!action) return { type: 'session', action: 'list', args: [] };
  return { type: 'session', action, args: parts.slice(2) };
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/utils/command.ts src/utils/command.test.ts
git commit -m "feat: add /session command parsing"
```

---

### Task 4: Add /session command handlers and integrate resume into handleClaudeTask

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Add /session list handler**

In `handleCommand`, add case `'session'`:

```typescript
case 'session': {
  const { listLocalSessions, findSessionById, getRecentMessages } = await import('../../session/local-sessions.js');

  if (cmd.action === 'list' || !cmd.action) {
    const sessions = listLocalSessions(10);
    if (sessions.length === 0) {
      await reply('没有发现本地 Claude Code 会话。');
      return;
    }
    const lines = ['📋 **最近的 Claude Code 会话**\n'];
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const ago = formatTimeAgo(s.lastModified);
      const active = s.isActive ? '  🔒 使用中' : '';
      lines.push(`${i + 1}. 📁 ${s.projectName} · ${ago}${active}`);
      lines.push(`   "${s.summary}"`);
      lines.push(`   ID: ${s.sessionId.slice(0, 8)}\n`);
    }
    lines.push('使用 /session resume <ID> 恢复会话');
    await reply(lines.join('\n'));
    return;
  }

  if (cmd.action === 'resume') {
    const idPrefix = cmd.args[0];
    if (!idPrefix) { await reply('用法: /session resume <ID>'); return; }

    const session = findSessionById(idPrefix);
    if (!session) { await reply(`未找到 ID 以 "${idPrefix}" 开头的会话`); return; }
    if (session.isActive) {
      await reply(`该会话正在被本地 CLI 使用中 (PID: ${session.activePid})，请先关闭本地会话。`);
      return;
    }

    // Save resumed session to DB
    db.setResumedSession(ctx.senderId, session.sessionId, session.cwd);

    // Show recent messages as context
    const messages = getRecentMessages(session.sessionId, 5);
    const lines = [`🔄 **恢复会话:** "${session.summary}"\n📁 ${session.projectName} · ${formatTimeAgo(session.lastModified)}\n`];
    if (messages.length > 0) {
      lines.push('**最近对话：**');
      for (const m of messages) {
        const prefix = m.role === 'user' ? '👤 你' : '🤖 Claude';
        lines.push(`${prefix}: ${m.text.slice(0, 100)}${m.text.length > 100 ? '...' : ''}`);
      }
      lines.push('');
    }
    lines.push('会话已恢复，可以继续对话。发送 /reset 可退出恢复模式。');
    await reply(lines.join('\n'));
    return;
  }

  await reply('用法: /session list 或 /session resume <ID>');
  return;
}
```

Add `formatTimeAgo` helper at module level:
```typescript
function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}
```

- [ ] **Step 2: Modify handleClaudeTask to use resumed session**

In `handleClaudeTask`, after `resolveProjectPath`, check if user has a resumed CLI session:

```typescript
// Check if user has a resumed CLI session (overrides normal session/cwd)
const user = db.getUser(ctx.senderId);
let projectPath: string;
let projectName: string;
let resumedCliSession: string | null = null;

if (user?.resumed_session_id && user?.resumed_cwd) {
  // Using a resumed CLI session — use its cwd and sessionId
  projectPath = user.resumed_cwd;
  projectName = user.resumed_cwd.split('/').pop() || 'CLI Session';
  resumedCliSession = user.resumed_session_id;
} else {
  // Normal flow
  const resolved = resolveProjectPath(ctx.senderId, db, projectManager);
  projectPath = resolved.projectPath;
  projectName = resolved.projectName;
}
```

Then when creating the session and calling executor, use the resumed session ID:

```typescript
const session = sessionManager.getOrCreate(ctx.senderId, ctx.threadId, projectName);
// If resuming CLI session, use its session ID; otherwise use bot session
const effectiveSessionId = resumedCliSession || session.claude_session_id;
```

Pass `effectiveSessionId` to `executeClaudeTask` instead of `session.claude_session_id`.

- [ ] **Step 3: Clear resumed session on /reset**

In the existing `/reset` handler, add:
```typescript
db.clearResumedSession(ctx.senderId);
```

- [ ] **Step 4: Update /help text**

Add session commands:
```
'/session list — 列出本地 Claude Code 会话',
'/session resume <ID> — 恢复指定会话',
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: add /session list and /session resume commands"
```

---

### Task 5: Manual testing

- [ ] **Step 1: Test /session list**

1. Start bot: `npx tsx src/index.ts`
2. Send `/session list` to bot
3. Verify: shows recent CLI sessions with project name, summary, time, IDs
4. Verify: active sessions marked with 🔒

- [ ] **Step 2: Test /session resume**

1. Send `/session resume <first-8-chars>` for a non-active session
2. Verify: shows recent messages preview
3. Send a follow-up message (e.g., "刚才聊到哪了？")
4. Verify: Claude has the CLI session's context

- [ ] **Step 3: Test /reset exits resume mode**

1. Send `/reset`
2. Send a new message
3. Verify: bot uses normal session (not the CLI session)

- [ ] **Step 4: Test edge cases**

1. `/session resume nonexistent` → error message
2. `/session resume` (no ID) → usage hint
3. `/session list` when no sessions exist → "没有发现" message
4. Resume an active session → "正在使用中" warning
