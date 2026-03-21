# Group Chat Model (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change group chat sessions from per-user to shared (per-thread and per-group), add group home projects, thread project binding, and group-admin-gated `/session new` and `/project use`.

**Architecture:** Sessions in group chats are keyed by `(chatId, threadId, projectName)` instead of `(userId, threadId, projectName)`. Each group gets an auto-created home project directory. Threads can bind to a specific project (one-time, stored in a new `thread_bindings` DB table). Group admin status is fetched from the Feishu API with 30-minute caching. `/session new` and `/project use` in groups require admin or thread-creator permissions.

**Tech Stack:** `@larksuiteoapi/node-sdk` (Feishu chat members API), `better-sqlite3`, existing session/dispatch infrastructure

---

## File Structure

| File | Change |
|------|--------|
| Create: `src/auth/group-admin.ts` | Fetch and cache group admin status from Feishu API |
| Modify: `src/session/db.ts` | Add `thread_bindings` table; add group session methods |
| Modify: `src/session/manager.ts` | Support group-shared sessions (chatId-based keying) |
| Modify: `src/messaging/inbound/dispatch.ts` | Group-aware session resolution, thread binding, admin-gated commands |
| Modify: `src/project/manager.ts` | `ensureGroupDefault(chatId)` for group home projects |
| Modify: `src/config.ts` | (No change needed — `adminUserIds` already exists) |

---

### Task 1: Add group admin check module

**Files:**
- Create: `src/auth/group-admin.ts`
- Create: `src/auth/group-admin.test.ts`

- [ ] **Step 1: Write tests**

Test cases (mock Feishu API):
1. `isGroupAdmin(chatId, userId)` — user is owner → true
2. `isGroupAdmin(chatId, userId)` — user is regular member → false
3. `isGroupAdmin(chatId, userId)` — result is cached for 30 minutes
4. `isGroupAdmin(chatId, userId)` — API failure → returns false (safe default)

- [ ] **Step 2: Implement group-admin.ts**

```typescript
import { getClient } from '../messaging/outbound/send.js';
import { logger } from '../logger.js';

// Cache: chatId → { members: Map<userId, role>, fetchedAt: number }
const cache = new Map<string, { admins: Set<string>; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function isGroupAdmin(chatId: string, userId: string): Promise<boolean> {
  const cached = cache.get(chatId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.admins.has(userId);
  }

  try {
    const client = getClient();
    const admins = new Set<string>();
    // Fetch chat info to get owner
    const chatResp = await client.im.v1.chat.get({
      path: { chat_id: chatId },
    });
    const ownerId = (chatResp as any)?.data?.owner_id;
    if (ownerId) admins.add(ownerId);

    // Fetch members with admin role
    // Feishu chat members API returns member_type for each member
    let pageToken: string | undefined;
    do {
      const resp = await (client as any).im.v1.chatMembers.get({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      const items = (resp as any)?.data?.items ?? [];
      for (const item of items) {
        // member_type: 'owner' or other admin indicators
        if (item.member_type === 'owner') {
          admins.add(item.member_id);
        }
      }
      pageToken = (resp as any)?.data?.page_token;
    } while (pageToken);

    cache.set(chatId, { admins, fetchedAt: Date.now() });
    return admins.has(userId);
  } catch (err) {
    logger.warn({ err, chatId, userId }, 'Failed to check group admin status');
    return false;
  }
}

export function clearGroupAdminCache(chatId?: string): void {
  if (chatId) cache.delete(chatId);
  else cache.clear();
}
```

Notes:
- Check both `member_type === 'owner'` and other admin-equivalent roles (e.g., `'administrator'`). The exact Feishu API enum values should be verified against the Lark SDK.
- The `chat.get` call can be dropped if `chatMembers.get` already returns the owner with their role.
- Import `isGroupAdmin` statically in dispatch.ts (not dynamically) since it's used on hot paths.

- [ ] **Step 3: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: add group admin check with 30min cache"`

---

### Task 2: Add thread_bindings table and group session support

**Files:**
- Modify: `src/session/db.ts`
- Test: `src/session/db.test.ts`

- [ ] **Step 1: Write tests**

Test cases:
1. `setThreadBinding(chatId, threadId, projectName, userId)` + `getThreadBinding(chatId, threadId)` → returns binding
2. `getThreadBinding` for unbound thread → returns null
3. `setThreadBinding` twice → error or no-op (already bound)
4. Group session: `findSession` with `chat_id` key works

- [ ] **Step 2: Add thread_bindings table**

In `migrate()`:
```sql
CREATE TABLE IF NOT EXISTS thread_bindings (
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_name TEXT,
  creator_user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, thread_id)
)
```

`project_name` is nullable — a row can exist just to record the thread creator before any project is bound.

Add methods:
```typescript
// Record thread creator on first interaction (project_name can be null)
ensureThreadCreator(chatId: string, threadId: string, creatorUserId: string): void
// Bind a project to a thread (one-time)
setThreadBinding(chatId: string, threadId: string, projectName: string, boundBy: string): boolean // false if already bound
// Get binding info
getThreadBinding(chatId: string, threadId: string): { projectName: string | null; creatorUserId: string } | null
```

Thread creator is captured in `event-handlers.ts` on the first message in a thread (before dispatch).

- [ ] **Step 3: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "feat: add thread_bindings table for group project binding"`

---

### Task 3: Add group home project support

**Files:**
- Modify: `src/project/manager.ts`
- Test: `src/project/manager.test.ts`

- [ ] **Step 1: Add ensureGroupDefault method**

Similar to `ensureUserDefault`, creates a group-specific directory. Returns both path and canonical project name for consistent session keying:

```typescript
ensureGroupDefault(chatId: string): { path: string; projectName: string } {
  const sanitized = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const projectName = `group-${sanitized}`;
  const groupDir = join(this.workspaceDir, 'groups', sanitized);
  if (!existsSync(groupDir)) {
    mkdirSync(groupDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: groupDir, stdio: 'ignore' });
  }
  return { path: groupDir, projectName };
}
```

- [ ] **Step 2: Write test**

Test: `ensureGroupDefault('oc_123')` creates `groups/oc_123/` with git init.

- [ ] **Step 3: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "feat: add group home project directory support"`

---

### Task 4: Modify SessionManager for group-shared sessions

**Files:**
- Modify: `src/session/manager.ts`
- Modify: `src/session/db.ts`
- Test: `src/session/manager.test.ts`

- [ ] **Step 1: Add group session methods to DB**

In `db.ts`, add a group-specific session finder that uses `chat_id` instead of `feishu_user_id`:

```typescript
findGroupSession(chatId: string, threadId: string | null, projectName: string): SessionRow | null {
  return this.db.prepare(
    'SELECT * FROM sessions WHERE feishu_user_id = ? AND topic_id IS ? AND project_name = ?'
  ).get(`group:${chatId}`, threadId, projectName) as SessionRow | null;
}

createGroupSession(chatId: string, threadId: string | null, projectName: string): SessionRow {
  const id = randomUUID();
  this.db.prepare(
    'INSERT INTO sessions (id, feishu_user_id, topic_id, project_name) VALUES (?, ?, ?, ?)'
  ).run(id, `group:${chatId}`, threadId, projectName);
  return this.findGroupSession(chatId, threadId, projectName)!;
}
```

Use `group:<chatId>` as the `feishu_user_id` to distinguish from regular user sessions without schema changes.

- [ ] **Step 2: Add getOrCreateGroup to SessionManager**

```typescript
getOrCreateGroup(chatId: string, threadId: string | null, projectName: string): SessionRow {
  const existing = this.db.findGroupSession(chatId, threadId, projectName);
  if (existing) {
    this.db.touchSession(existing.id);
    return existing;
  }
  return this.db.createGroupSession(chatId, threadId, projectName);
}

resetGroup(chatId: string, threadId: string | null, projectName: string): void {
  const session = this.db.findGroupSession(chatId, threadId, projectName);
  if (session) {
    this.db.resetSession(session.id);
  }
}
```

- [ ] **Step 3: Write tests**

Test: getOrCreateGroup creates and retrieves a session. resetGroup clears claude_session_id.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "feat: add group-shared session support to SessionManager"`

---

### Task 5: Integrate group chat model into dispatch

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

This is the core integration task. Multiple changes needed.

- [ ] **Step 1: Create resolveGroupProject helper**

Add a helper that resolves the project for a group context:

```typescript
function resolveGroupProject(
  chatId: string, threadId: string | null, db: Database, projectManager: ProjectManager,
): { projectName: string; projectPath: string } {
  // 1. If thread has a project binding, use it
  if (threadId) {
    const binding = db.getThreadBinding(chatId, threadId);
    if (binding?.projectName) {
      // Try bot project first
      try { return { projectName: binding.projectName, projectPath: projectManager.resolve(binding.projectName) }; }
      catch { /* not a bot project — fall through to group home */ }
    }
  }
  // 2. Default: group home project
  const { path: groupDir, projectName } = projectManager.ensureGroupDefault(chatId);
  return { projectName, projectPath: groupDir };
}
```

- [ ] **Step 2: Modify handleClaudeTask for group chats**

In `handleClaudeTask`, the current code (around line 576-620) resolves project path and creates session. Replace the project/session resolution block with a group-aware version:

```typescript
let projectPath: string;
let projectName: string;
let session: SessionRow;
const threadId = ctx.threadId ?? undefined;

if (ctx.chatType === 'group') {
  // Group chat: shared session, group project
  const resolved = resolveGroupProject(ctx.chatId, ctx.threadId, db, projectManager);
  projectPath = resolved.projectPath;
  projectName = resolved.projectName;
  session = sessionManager.getOrCreateGroup(ctx.chatId, ctx.threadId, projectName);
} else {
  // P2P chat: per-user session (existing logic)
  const user = db.getUser(ctx.senderId);
  let resumedCliSession: string | null = null;
  if (user?.resumed_session_id && user?.resumed_cwd) {
    projectPath = user.resumed_cwd;
    projectName = user.resumed_cwd.split('/').pop() || 'CLI Session';
    resumedCliSession = user.resumed_session_id;
  } else {
    const resolved = resolveProjectPath(ctx.senderId, db, projectManager);
    projectPath = resolved.projectPath;
    projectName = resolved.projectName;
  }
  // Permission check
  if (!hasAccess(ctx.senderId, projectName, config.workspaceDir, config)) {
    await sendText(ctx.chatId, '没有权限访问当前项目', threadId);
    return;
  }
  session = sessionManager.getOrCreate(ctx.senderId, ctx.threadId, projectName);
  if (resumedCliSession) {
    // Override session ID for CLI resume
    session = { ...session, claude_session_id: resumedCliSession };
  }
}
```

The key change: group chats use `getOrCreateGroup` (keyed by chatId), p2p chats use the existing `getOrCreate` (keyed by userId). All existing p2p logic is preserved.

- [ ] **Step 3: Capture thread creator in event-handlers**

In `event-handlers.ts`, in the `im.message.receive_v1` handler, after parsing the message context but before dispatching, record the thread creator if this is a group thread:

```typescript
// Capture thread creator for group threads (needed for permission checks)
if (ctx.chatType === 'group' && ctx.threadId) {
  deps.db.ensureThreadCreator(ctx.chatId, ctx.threadId, ctx.senderId);
}
```

This is idempotent — `ensureThreadCreator` only inserts if no row exists for this (chatId, threadId), so the first user to send a message in the thread is recorded as creator.

- [ ] **Step 4: Add /project use thread binding in groups**

In the `/project use` handler, add group chat logic:

```typescript
// In group chat: bind project to thread (one-time)
if (ctx.chatType === 'group') {
  if (!ctx.threadId) {
    // Group-level: only admin can change
    const isAdminUser = isAdmin(ctx.senderId, config) || await isGroupAdmin(ctx.chatId, ctx.senderId);
    if (!isAdminUser) { await reply('只有群管理员可以切换群项目'); return; }
    // Group-level project switching... (future consideration)
    await reply('群主消息区使用群默认目录，请在话题中切换项目');
    return;
  }
  // Thread: check if already bound
  const existing = db.getThreadBinding(ctx.chatId, ctx.threadId);
  if (existing) {
    await reply(`该话题已绑定项目 ${existing.projectName}，不可更改`);
    return;
  }
  // Check permission: thread creator or admin
  // (For simplicity, allow any user in thread to bind — first one wins)
  db.setThreadBinding(ctx.chatId, ctx.threadId, name, ctx.senderId);
  // Reset session context for fresh start
  sessionManager.resetGroup(ctx.chatId, ctx.threadId, name);
  await reply(`话题已绑定项目 ${name}，对话上下文已重置`);
  return;
}
```

- [ ] **Step 5: Add /session new admin check in groups**

In the `/session new` handler, add group permission check:

```typescript
if (cmd.action === 'new') {
  const currentUser = db.getUser(ctx.senderId);
  const project = currentUser?.active_project || DEFAULT_PROJECT_LABEL;

  if (ctx.chatType === 'group') {
    // Group: only admin or thread creator can reset
    // isGroupAdmin imported statically at top of file
    let canReset = isAdmin(ctx.senderId, config) || await isGroupAdmin(ctx.chatId, ctx.senderId);
    if (!canReset && ctx.threadId) {
      // Thread creator can also reset
      const binding = db.getThreadBinding(ctx.chatId, ctx.threadId);
      if (binding?.creatorUserId === ctx.senderId) canReset = true;
    }
    if (!canReset) {
      await reply('只有群管理员或话题发起者可以重置会话');
      return;
    }
    const groupProject = resolveGroupProject(ctx.chatId, ctx.threadId, db, projectManager);
    sessionManager.resetGroup(ctx.chatId, ctx.threadId, groupProject.projectName);
    await reply('已创建新会话，对话上下文已清空。');
    return;
  }

  // P2P: same as before
  sessionManager.reset(ctx.senderId, ctx.threadId, project);
  await reply('已创建新会话，对话上下文已清空。');
  return;
}
```

- [ ] **Step 6: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 7: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: integrate group chat model — shared sessions, thread binding, admin checks"
```

---

### Task 6: Manual testing

- [ ] **Step 1: Test group chat shared session**

1. Add bot to a test group
2. @bot in group (non-thread) → bot responds
3. Have another user @bot in same group → verify they share the same conversation context
4. `/status` → shows group project

- [ ] **Step 2: Test thread project binding**

1. Create a thread in the group
2. @bot in thread → uses group home project
3. `/project use <project>` in thread → binds project, resets context
4. @bot again → works in the bound project
5. Try `/project use <other>` → should be rejected (already bound)

- [ ] **Step 3: Test /session new permissions**

1. Regular user sends `/session new` in group → rejected
2. Group admin/owner sends `/session new` → succeeds
3. Thread creator sends `/session new` in their thread → succeeds

- [ ] **Step 4: Test p2p unchanged**

1. DM bot → verify per-user sessions still work as before
2. All existing commands work in DM
