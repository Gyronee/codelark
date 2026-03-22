# Project List Merge + Dynamic Help (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge bot-created projects and local CLI projects into a unified `/project list`, and make `/help` dynamic based on user permissions.

**Architecture:** `/project list` combines two data sources — `ProjectManager.list()` (bot projects) and `listLocalSessions()` (CLI projects, grouped by projectName). Both are filtered by `hasAccess()`. Output is rendered as a Feishu card with markdown. `/help` checks `isAdmin()`, project creator status, and current context to show only relevant commands.

**Tech Stack:** Existing modules: `ProjectManager`, `listLocalSessions`, `hasAccess`, `sendCard`, `CardBuilder`

---

## File Structure

| File | Change |
|------|--------|
| Modify: `src/messaging/inbound/dispatch.ts` | Rewrite `/project list` to merge sources; rewrite `/help` to be dynamic |

This is a focused change — only dispatch.ts needs modification. The data sources and permission checks are already in place from Phase 1.

---

### Task 1: Rewrite /project list to merge bot + CLI projects

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Rewrite the 'list' case in handleProjectCommand**

Replace the current `case 'list'` with:

```typescript
case 'list': {
  // Source 1: Bot-created projects (from projects.json)
  const botProjects = projectManager.list()
    .filter(p => hasAccess(ctx.senderId, p.name, config.workspaceDir, config));

  // Source 2: Local CLI projects (from ~/.claude/projects/)
  const { listLocalSessions } = await import('../../session/local-sessions.js');
  let cliSessions = listLocalSessions(20);
  if (config.sessionTitledOnly) {
    cliSessions = cliSessions.filter(s => s.hasCustomTitle);
  }
  cliSessions = cliSessions.filter(s => hasAccess(ctx.senderId, s.projectName, config.workspaceDir, config));

  // Group CLI sessions by projectName, keep most recent per project
  const cliProjects = new Map<string, typeof cliSessions[0]>();
  for (const s of cliSessions) {
    const existing = cliProjects.get(s.projectName);
    if (!existing || s.lastModified > existing.lastModified) {
      cliProjects.set(s.projectName, s);
    }
  }

  // Merge: deduplicate (if a bot project name matches a CLI project name, show as one entry with CLI info)
  const lines: string[] = [];
  let index = 1;
  const shownNames = new Set<string>();

  // Show CLI projects first (sorted by recency, more relevant)
  for (const [name, session] of cliProjects) {
    shownNames.add(name);
    const ago = formatTimeAgo(session.lastModified);
    const botProject = botProjects.find(p => p.name === name);
    const source = botProject ? '本地+Bot' : '本地';
    const title = session.hasCustomTitle ? session.summary : '';
    lines.push(`${index}. **${name}** (${source})${session.isActive ? ' · 🔒 使用中' : ''}`);
    if (title) lines.push(`    "${title}"`);
    lines.push(`    🕐 ${ago} · ID: ${session.sessionId.slice(0, 8)}`);
    index++;
  }

  // Show remaining bot-only projects
  for (const p of botProjects) {
    if (shownNames.has(p.name)) continue;
    lines.push(`${index}. **${p.name}** (Bot)`);
    if (p.description) lines.push(`    ${p.description}`);
    index++;
  }

  if (lines.length === 0) {
    await reply('没有可访问的项目。使用 /project create <名称> 或 /project clone <地址> 创建项目。');
    return;
  }

  lines.push('---');
  lines.push('/project use <名称> 切换项目');
  lines.push('/session resume <ID> 恢复 CLI 会话');

  await sendCard(ctx.chatId, {
    header: { title: { tag: 'plain_text', content: '📋 项目列表' }, template: 'blue' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }, threadId);
  return;
}
```

Note: `threadId` is available in `handleCommand` scope (line 76: `const threadId = ctx.threadId ?? undefined`). `sendCard` needs to be accessible — it's already imported.

- [ ] **Step 2: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: /project list merges bot and CLI projects with access filtering"
```

---

### Task 2: Rewrite /help to be dynamic

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Rewrite the 'help' case**

Replace the current static help with dynamic help that checks permissions:

```typescript
case 'help': {
  const admin = isAdmin(ctx.senderId, config);
  const user = db.getUser(ctx.senderId);
  const currentProject = user?.active_project;
  // Check if user can grant on current project (creator or admin)
  const canGrantCurrent = currentProject ? canGrant(ctx.senderId, currentProject, config.workspaceDir, config) : false;

  const lines = [
    '📋 **可用命令**', '',
    '/help — 显示帮助信息',
    '/status — 查看当前状态',
    '/whoami — 查看你的 open_id', '',
    '💬 **会话：**',
    '/reset — 重置当前对话上下文',
    '/cancel — 取消正在执行的任务',
    '/model — 查看/切换模型', '',
    '📁 **项目管理：**',
    '/project list — 列出所有项目',
    '/project use <名称> — 切换到指定项目',
    '/project create <名称> — 创建新空项目',
    '/project clone <地址> — 克隆 Git 仓库',
    '/project home — 切换到个人目录',
    '/file <path> — 从项目目录获取文件',
  ];

  // Permission management (only show if user can grant)
  if (canGrantCurrent || admin) {
    lines.push('/project grant <用户> — 授权用户访问当前项目');
    lines.push('/project revoke <用户> — 撤销用户权限');
    lines.push('/project access — 查看当前项目授权列表');
  }
  if (admin) {
    lines.push('/project grant <用户> <项目> — 授权用户访问指定项目');
    lines.push('/project revoke <用户> <项目> — 撤销指定项目权限');
  }

  lines.push('', '🖥️ **本地会话：**');
  lines.push('/session list — 列出本地 Claude Code 会话');
  lines.push('/session resume <ID> — 恢复指定会话');
  if (user?.resumed_session_id) {
    lines.push('/session exit — 退出恢复模式');
  }

  lines.push('', '🔑 **授权：**');
  lines.push('/auth — 授权飞书账号（文档读写）');

  lines.push('', '---');
  lines.push('直接发送文字即可与 Claude Code 对话。');
  lines.push('无需设置项目，系统会自动为你创建独立的工作目录。');

  await reply(lines.join('\n'));
  break;
}
```

- [ ] **Step 2: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: dynamic /help based on user permissions"
```

---

### Task 3: Manual testing

- [ ] **Step 1: Test /project list**

1. Start bot
2. Send `/project list`
3. Verify: shows both bot projects and local CLI projects in one card
4. Verify: CLI projects show session info (title, time, ID)
5. Verify: only projects user has access to are shown

- [ ] **Step 2: Test /help as admin**

1. Send `/help`
2. Verify: shows grant/revoke/access commands

- [ ] **Step 3: Test /help as non-admin (if possible)**

1. If testing with a second user, verify grant/revoke commands are hidden
2. Or verify that `/session exit` only shows when in resume mode
