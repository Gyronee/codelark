# Permissions System (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified permission model so project/session/file operations are gated by per-user per-project access control, managed via `access.json` file and `/project grant/revoke/access` commands.

**Architecture:** A new `src/auth/access.ts` module reads `access.json` from the workspace root on every permission check (no caching, instant effect). It combines three sources: access.json rules, project creator ownership (tracked in `projects.json`), and personal directory auto-access. Permission checks are inserted at all project operation points: `/project use`, `/session resume`, `/file`, `handleClaudeTask`. Admin users (`ADMIN_USER_IDS` in `.env`) can grant/revoke any project.

**Tech Stack:** Node.js `fs` (read/write JSON), existing `ProjectManager`, existing command parsing infrastructure

---

## File Structure

| File | Responsibility |
|------|---------------|
| Create: `src/auth/access.ts` | Read `access.json`, check permissions, write grants/revokes |
| Create: `src/auth/access.test.ts` | Tests for permission logic |
| Modify: `src/config.ts` | Add `adminUserIds` config field |
| Modify: `src/project/config.ts` | Add `creator` field to project entries |
| Modify: `src/project/manager.ts` | Record creator on create/clone |
| Modify: `src/utils/command.ts` | Parse grant/revoke/access actions |
| Modify: `src/messaging/inbound/dispatch.ts` | Add permission checks + grant/revoke/access handlers |
| Modify: `src/session/local-sessions.ts` | Filter by permission |

---

### Task 1: Add ADMIN_USER_IDS config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add adminUserIds to Config interface and loadConfig**

Add `adminUserIds: string[]` to the Config interface. In `loadConfig()`:
```typescript
adminUserIds: parseList(process.env.ADMIN_USER_IDS),
```

- [ ] **Step 2: Fix test files that construct Config objects**

Add `adminUserIds: []` to Config objects in `src/integration.test.ts` and `src/messaging/inbound/gate.test.ts`.

- [ ] **Step 3: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "feat: add ADMIN_USER_IDS config"`

---

### Task 2: Track project creator

**Files:**
- Modify: `src/project/config.ts`
- Modify: `src/project/manager.ts`
- Test: `src/project/manager.test.ts`

- [ ] **Step 1: Add creator field to ProjectEntry**

In `src/project/config.ts`, add `creator?: string` to the `ProjectEntry` interface (the type used in `projects` record values).

- [ ] **Step 2: Record creator in create() and clone()**

In `src/project/manager.ts`:
- `create(name, userId?)` — add optional `userId` parameter, store as `creator` in project config
- `clone(url, userId?)` — same

When writing to `projects.json`, include `creator: userId` in the project entry.

- [ ] **Step 3: Update callers in dispatch.ts**

Pass `ctx.senderId` when calling `projectManager.create()` and `projectManager.clone()`.

- [ ] **Step 4: Write tests**

Test: create project with userId → readConfig shows creator field.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "feat: track project creator in projects.json"`

---

### Task 3: Create access.ts permission module

**Files:**
- Create: `src/auth/access.ts`
- Create: `src/auth/access.test.ts`

- [ ] **Step 1: Write tests**

Test cases:
1. `hasAccess(userId, projectName, config)` — user in access.json → true
2. `hasAccess(userId, projectName, config)` — user NOT in access.json → false
3. `hasAccess(userId, projectName, config)` — user has wildcard `"*"` → true for any project
4. `hasAccess(userId, projectName, config)` — user's personal directory → always true
5. `hasAccess(userId, projectName, config)` — user is project creator → true
6. `hasAccess(userId, projectName, config)` — access.json doesn't exist → only personal dir and creator access work
7. `grantAccess(workspaceDir, userId, projectName)` — adds user to access.json
8. `revokeAccess(workspaceDir, userId, projectName)` — removes user from access.json
9. `getProjectAccess(workspaceDir, projectName)` — returns list of allowed users
10. `isAdmin(userId, config)` — checks ADMIN_USER_IDS

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement access.ts**

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readConfig } from '../project/config.js';
import type { Config } from '../config.js';

interface AccessConfig {
  projects: Record<string, { allowedUsers: string[] }>;
}

// Read access.json every time (no cache — edits take effect immediately)
function readAccessConfig(workspaceDir: string): AccessConfig {
  const filePath = join(workspaceDir, 'access.json');
  if (!existsSync(filePath)) return { projects: {} };
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { return { projects: {} }; }
}

function writeAccessConfig(workspaceDir: string, config: AccessConfig): void {
  const filePath = join(workspaceDir, 'access.json');
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}

export function isAdmin(userId: string, config: Config): boolean {
  return config.adminUserIds.includes(userId);
}

export function hasAccess(
  userId: string, projectName: string, workspaceDir: string, config: Config,
): boolean {
  // 1. Admin has access to everything
  if (isAdmin(userId, config)) return true;

  // 2. Personal directory — always accessible
  if (isPersonalProject(userId, projectName)) return true;

  // 3. Project creator — always accessible
  const projectConfig = readConfig(workspaceDir);
  const projectEntry = projectConfig.projects[projectName];
  if (projectEntry?.creator === userId) return true;

  // 4. Check access.json
  const access = readAccessConfig(workspaceDir);
  const projectAccess = access.projects[projectName];
  const wildcardAccess = access.projects['*'];
  if (projectAccess?.allowedUsers.includes(userId)) return true;
  if (wildcardAccess?.allowedUsers.includes(userId)) return true;

  return false;
}

function isPersonalProject(userId: string, projectName: string): boolean {
  // Personal project name matches DEFAULT_PROJECT_LABEL or user workspace pattern
  return projectName === 'My Workspace';
}

export function canGrant(
  userId: string, projectName: string, workspaceDir: string, config: Config,
): boolean {
  if (isAdmin(userId, config)) return true;
  const projectConfig = readConfig(workspaceDir);
  return projectConfig.projects[projectName]?.creator === userId;
}

export function grantAccess(workspaceDir: string, userId: string, projectName: string): void {
  const access = readAccessConfig(workspaceDir);
  if (!access.projects[projectName]) {
    access.projects[projectName] = { allowedUsers: [] };
  }
  if (!access.projects[projectName].allowedUsers.includes(userId)) {
    access.projects[projectName].allowedUsers.push(userId);
  }
  writeAccessConfig(workspaceDir, access);
}

export function revokeAccess(workspaceDir: string, userId: string, projectName: string): void {
  const access = readAccessConfig(workspaceDir);
  const entry = access.projects[projectName];
  if (entry) {
    entry.allowedUsers = entry.allowedUsers.filter(u => u !== userId);
    if (entry.allowedUsers.length === 0) delete access.projects[projectName];
  }
  writeAccessConfig(workspaceDir, access);
}

export function getProjectAccess(workspaceDir: string, projectName: string): string[] {
  const access = readAccessConfig(workspaceDir);
  return access.projects[projectName]?.allowedUsers ?? [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/auth/access.ts src/auth/access.test.ts
git commit -m "feat: add unified permission module (access.json)"
```

---

### Task 4: Add grant/revoke/access command parsing

**Files:**
- Modify: `src/utils/command.ts`
- Test: `src/utils/command.test.ts`

- [ ] **Step 1: Write tests**

Test cases:
1. `/project grant ou_xxx` → `{ type: 'project', action: 'grant', args: ['ou_xxx'] }`
2. `/project grant ou_xxx remote-control` → `{ type: 'project', action: 'grant', args: ['ou_xxx', 'remote-control'] }`
3. `/project revoke ou_xxx` → `{ type: 'project', action: 'revoke', args: ['ou_xxx'] }`
4. `/project access` → `{ type: 'project', action: 'access', args: [] }`

- [ ] **Step 2: Verify these already work**

The current `/project` parsing already handles arbitrary actions: `action = parts[1]`, `args = parts.slice(2)`. So `grant`, `revoke`, `access` should already parse correctly. Just add test cases to verify. No code changes needed in command.ts.

- [ ] **Step 3: Run tests and commit**

Run: `npx vitest run`
Commit: `git commit -m "test: add grant/revoke/access command parsing tests"`

---

### Task 5: Add permission checks and grant/revoke handlers in dispatch

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Import access module**

Add import at top:
```typescript
import { hasAccess, canGrant, grantAccess, revokeAccess, getProjectAccess, isAdmin } from '../../auth/access.js';
```

- [ ] **Step 2: Add grant/revoke/access handlers in handleProjectCommand**

In the switch inside `handleProjectCommand`, add cases:

```typescript
case 'grant': {
  const targetUser = cmd.args[0];
  if (!targetUser) { await reply('用法: /project grant <用户ID> [项目名]'); return; }
  const targetProject = cmd.args[1] || user?.active_project;
  if (!targetProject) { await reply('请先切换到一个项目，或指定项目名'); return; }
  if (!canGrant(ctx.senderId, targetProject, config.workspaceDir, config)) {
    await reply('没有权限：只有项目创建者或管理员可以授权'); return;
  }
  grantAccess(config.workspaceDir, targetUser, targetProject);
  await reply(`已授权 ${targetUser} 访问项目 ${targetProject}`);
  break;
}
case 'revoke': {
  const targetUser = cmd.args[0];
  if (!targetUser) { await reply('用法: /project revoke <用户ID> [项目名]'); return; }
  const targetProject = cmd.args[1] || user?.active_project;
  if (!targetProject) { await reply('请先切换到一个项目，或指定项目名'); return; }
  if (!canGrant(ctx.senderId, targetProject, config.workspaceDir, config)) {
    await reply('没有权限：只有项目创建者或管理员可以撤销授权'); return;
  }
  revokeAccess(config.workspaceDir, targetUser, targetProject);
  await reply(`已撤销 ${targetUser} 对项目 ${targetProject} 的权限`);
  break;
}
case 'access': {
  const targetProject = cmd.args[0] || user?.active_project;
  if (!targetProject) { await reply('请先切换到一个项目，或指定项目名'); return; }
  const users = getProjectAccess(config.workspaceDir, targetProject);
  if (users.length === 0) {
    await reply(`项目 ${targetProject} 没有额外授权用户（创建者和管理员始终有权限）`);
  } else {
    await reply(`项目 ${targetProject} 的授权用户:\n${users.map(u => `• ${u}`).join('\n')}`);
  }
  break;
}
```

- [ ] **Step 3: Add permission check to /project use**

In the existing `case 'use'`, after resolving the project, add:
```typescript
if (!hasAccess(ctx.senderId, name, config.workspaceDir, config)) {
  await reply('没有权限访问该项目'); return;
}
```

- [ ] **Step 4: Add permission check to /file**

In the `case 'file'` handler, after resolving projectDir, add permission check on the active project.

- [ ] **Step 5: Add permission check to handleClaudeTask**

In `handleClaudeTask`, after `resolveProjectPath`, check permission:
```typescript
if (!hasAccess(ctx.senderId, projectName, config.workspaceDir, config)) {
  await sendText(ctx.chatId, '没有权限访问当前项目，请使用 /project use 切换到有权限的项目', threadId);
  return;
}
```

- [ ] **Step 6: Add permission check to /session resume**

In the `case 'session'` resume handler, after finding the session, check permission on the session's project.

Need to map session's cwd to a project name. Use `path.basename(session.cwd)` as the project name for permission checking (same as `session.projectName`).

- [ ] **Step 7: Filter /session list by permission**

In the `case 'session'` list handler, filter sessions by permission:
```typescript
sessions = sessions.filter(s => hasAccess(ctx.senderId, s.projectName, config.workspaceDir, config));
```

- [ ] **Step 8: Pass config to handleProjectCommand and handleClaudeTask**

Ensure `config` is available in these functions (it's already passed through dispatch).

- [ ] **Step 9: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 10: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: add permission checks and grant/revoke/access commands"
```

---

### Task 6: Manual testing

- [ ] **Step 1: Test /project grant and revoke**

1. Start bot
2. `/project grant ou_xxx remote-control` (as admin) → success
3. Check `access.json` has the entry
4. `/project revoke ou_xxx remote-control` → success
5. Check `access.json` entry removed

- [ ] **Step 2: Test permission blocking**

1. Set `ADMIN_USER_IDS` to only your user
2. As a non-admin user, try `/project use <project>` for a project they don't have access to → blocked
3. As admin, try the same → allowed

- [ ] **Step 3: Test /session list filtering**

1. `/session list` → only shows sessions for projects user has access to

- [ ] **Step 4: Test /project access**

1. `/project access remote-control` → shows allowed users
