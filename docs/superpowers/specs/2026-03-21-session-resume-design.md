# 远程恢复本地 Claude Code Session

**Date:** 2026-03-21
**Status:** Draft

## Goal

让用户通过飞书 bot 远程恢复本地电脑上的 Claude Code CLI 会话，继续之前的对话。典型场景：用户在公司电脑上用 CLI 写了半天代码，回家路上用手机通过飞书 bot 继续操作。

## Scope

### In Scope

1. **`/session list`** — 列出本地 Claude Code 最近的会话，展示标题/首条 prompt、时间、项目目录
2. **`/session resume <id>`** — 恢复指定会话，展示最近 3-5 条对话消息，后续消息在该会话上下文中继续
3. **活跃检测** — 恢复前检查该 session 是否正在被本地 CLI 占用（通过 PID 存活检查）

### Out of Scope

- 跨机器 session 同步
- 创建新的 CLI session（用户用 bot 发消息本身就会创建 bot 自己的 session）
- V2 SDK API（使用现有 V1 `query({ resume })` 即可）

## Architecture

### Session 发现

```
~/.claude/sessions/<pid>.json     → 活跃 session 索引
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl → session 对话记录
```

扫描流程：
1. 遍历 `~/.claude/projects/*/` 下所有 `*.jsonl` 文件
2. 每个文件读取最后几行，提取 metadata（sessionId、timestamp、summary）
3. 按最后修改时间排序，取最近 10-20 个
4. 交叉检查 `~/.claude/sessions/*.json`，标记哪些正在被 CLI 使用

### 恢复流程

```
用户发送 /session resume ff48c101
        ↓
读取 session 的 cwd 和元数据
        ↓
检查 PID 存活 → 如果正在使用，提示用户
        ↓
发送恢复卡片（显示最近 3-5 条对话）
        ↓
将 sessionId 和 cwd 存入 DB（作为用户当前活跃 session）
        ↓
后续消息走现有 V1 query({ resume: sessionId, cwd }) 路径
        ↓
完全复用 streaming card、权限确认等现有逻辑
```

### 关键设计决策

**复用 V1 API，不引入 V2：** 现有的 `query({ options: { resume: sessionId } })` 已经能恢复任意 session，只要 `cwd` 正确。不需要引入 unstable V2 API，减少风险。

**Session 切换机制：** 恢复后，用户的 `active session` 切换到 CLI session。用户可以通过 `/session resume` 切换不同 session，或发 `/reset` 回到 bot 默认 session。

**cwd 处理：** 每个 CLI session 记录了 `cwd`。恢复时，executor 使用该 session 的原始 `cwd`，而非用户在 bot 中的 active project。这确保 Claude 能访问正确的项目文件。

## 用户交互

### /session list

展示为飞书卡片：

```
📋 最近的 Claude Code 会话

1. 📁 remote-control · 5分钟前
   "fix: reusable confirm card"
   ID: ff48c101

2. 📁 LawAssistant · 2小时前  🔒 使用中
   "帮我写一个 REST API"
   ID: ebcc05d4

3. 📁 remote-control · 5小时前
   "添加图片支持"
   ID: 3df7661a

使用 /session resume <ID> 恢复会话
```

标记 🔒 表示正在被 CLI 占用。

### /session resume <id>

恢复卡片：

```
🔄 恢复会话: "fix: reusable confirm card"
📁 remote-control · 5分钟前

最近对话：
👤 你: 启动 bot
🤖 Claude: Bot 已启动。
👤 你: 可以能用了，鼓掌
🤖 Claude: 太好了！确认卡片终于正常工作了...

会话已恢复，可以继续对话。
```

后续消息自动在该 session 上下文中继续。

## 新增模块

| 模块 | 职责 |
|------|------|
| `src/session/local-sessions.ts` | 扫描 `~/.claude/` 目录，发现和解析本地 CLI session 文件 |

### local-sessions.ts 接口

```typescript
interface LocalSession {
  sessionId: string;
  cwd: string;
  summary: string;        // customTitle 或 firstPrompt 或 sessionId 前 8 位
  lastModified: number;   // Unix ms
  isActive: boolean;      // 是否被 CLI 占用
  activePid?: number;     // 占用的 PID
}

// 列出最近的本地 session
function listLocalSessions(limit?: number): LocalSession[]

// 获取单个 session 的最近消息
function getRecentMessages(sessionId: string, count?: number): Array<{ role: 'user' | 'assistant'; text: string }>

// 查找 session 的 cwd
function getSessionCwd(sessionId: string): string | null
```

## 变更模块

| 模块 | 变更 |
|------|------|
| `src/utils/command.ts` | 添加 `/session` 命令解析（list / resume / info） |
| `src/messaging/inbound/dispatch.ts` | 添加 `/session` 命令处理 + handleClaudeTask 检查 resumed session 并使用其 sessionId 和 cwd |
| `src/session/db.ts` | users 表添加 `resumed_session_id` 和 `resumed_cwd` 字段；`/reset` 时清除 |

## Session 文件解析

JSONL 文件可能很大（长对话几 MB）。优化：

1. **列表时：** 只读文件的最后 4KB（`fs.read` 带 offset），从末尾解析最后几个 JSON 行获取 timestamp 和 metadata
2. **获取消息时：** 读取最后 N KB，解析出最近的 user/assistant 消息
3. **不加载整个文件到内存**

## Session 元数据获取

从 JSONL 最后几行提取：
- `sessionId` — 每行都有
- `timestamp` — 最后一行的时间
- `cwd` — 每行都有
- `gitBranch` — 最后一行
- Summary — 需要读文件前几行获取 `firstPrompt`，或从 `sessions/*.json` 索引获取

或者直接用文件的 `mtime` 作为 lastModified，比解析 JSONL 快。

## 活跃检测

```typescript
function isSessionActive(sessionId: string): { active: boolean; pid?: number } {
  // 扫描 ~/.claude/sessions/*.json
  // 找到 sessionId 匹配的条目
  // 检查 process.kill(pid, 0) 是否存活
}
```

`process.kill(pid, 0)` 不发信号，只检查进程是否存在。

## Constraints

- **只读本地文件** — 不修改 CLI 的 session 文件
- **性能** — 列表操作扫描目录 + 读文件尾部，应在 100ms 内完成
- **兼容性** — 依赖 Claude Code 的文件格式，CLI 更新可能 breaking
- **单机限制** — 只能恢复 bot 所在机器上的 session
- **格式兼容** — JSONL 尾部读取时，丢弃第一个不完整的行（跨 boundary 截断）
- **优雅降级** — 如果 `~/.claude/` 结构变化（CLI 更新），列表返回空而非报错
