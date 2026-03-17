# 飞书 × Claude Code 机器人设计文档

## 概述

构建一个飞书机器人，通过飞书消息界面连接真实的 Claude Code CLI（通过 Claude Code SDK），实现在飞书中进行开发工作。支持个人使用和 5 人以内小团队协作。

## 架构

### 整体架构

采用单体 Node.js/TypeScript 服务，通过飞书 WebSocket 长连接接收消息，调用 Claude Code SDK 执行开发任务，以交互式卡片流式返回结果。

```
┌─────────┐   WebSocket 长连接   ┌────────────────────────────┐
│  飞书    │ ←──────────────────→ │  Node.js 服务              │
│  客户端  │                      │                            │
└─────────┘                      │  ├─ 飞书 SDK (WebSocket)   │
                                 │  ├─ 会话管理器             │
                                 │  ├─ 项目管理器             │
                                 │  ├─ 卡片构建器             │
                                 │  └─ Claude Code SDK        │
                                 └──────────┬─────────────────┘
                                            │
                                         SQLite
                                            │
                                 ┌──────────┴──────────┐
                                 │  ~/workspaces/       │
                                 │  ├─ projects/        │
                                 │  └─ tmp/             │
                                 └─────────────────────┘
```

### 技术选型理由

- **Node.js/TypeScript**：Claude Code SDK (`@anthropic-ai/claude-code`) 原生支持，无需子进程中转
- **飞书 WebSocket 模式**：无需公网 URL，本地开发和云部署都可直接使用（借鉴 OpenClaw 飞书插件方案）
- **SQLite**：轻量、零配置，5 人团队无需外部数据库
- **单体架构**：5 人以内并发压力低，无需队列或微服务

## 飞书消息处理

### 连接方式

使用飞书官方 SDK（`@larksuiteoapi/node-sdk`）的 WebSocket 长连接模式接收事件，订阅 `im.message.receive_v1` 事件。

### 消息处理流程

```
收到消息 → 解析消息类型
                │
    ┌───────────┼───────────┐
    ↓           ↓           ↓
 命令消息     普通消息     不支持的类型
(/project等) (发给Claude)  (图片/文件等)
    │           │           │
    ↓           ↓           ↓
 执行命令    路由到会话    回复提示信息
                │
                ↓
        查找/创建会话上下文
                │
                ↓
        创建"思考中"卡片
                │
                ↓
        调用 Claude Code SDK
                │
                ↓
        流式更新卡片内容
                │
                ↓
        任务完成，更新最终卡片
```

### 内置命令

| 命令 | 行为 |
|------|------|
| `/project list` | 列出可用项目 |
| `/project use <name>` | 切换当前项目 |
| `/project clone <git-url>` | clone 仓库到临时目录 |
| `/project create <name>` | 创建新空项目（mkdir + git init） |
| `/reset` | 重置当前会话上下文 |
| `/cancel` | 取消正在执行的任务 |
| `/status` | 显示当前项目、会话状态、任务执行情况 |

### 会话路由逻辑

会话按 `(user_id, topic_id, project_name)` 三元组唯一标识：

- 群聊中有话题回复 → `(user_id, topic_id, active_project)`
- 群聊中无话题 → `(user_id, NULL, active_project)`
- 私聊 → `(user_id, NULL, active_project)`

切换项目会进入不同会话，切回来时恢复原会话。

## Claude Code SDK 调用

### 调用方式与流式输出

Claude Code SDK 返回一个 async iterable，通过 `for await` 消费流式事件：

```typescript
import { claude, EVENTS } from '@anthropic-ai/claude-code';

const conversation = claude({
  prompt: userMessage,
  cwd: projectPath,
  sessionId: existingSessionId,
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  abortController: controller,
});

for await (const event of conversation) {
  switch (event.type) {
    case 'assistant':
      // 文本输出 → 更新卡片文本区域（防抖）
      debouncedUpdateCard(cardId, event.content);
      break;
    case 'tool_use':
      // 工具调用开始 → 更新卡片状态栏
      updateToolStatus(cardId, `⟳ ${event.tool}(${event.input})`);
      break;
    case 'tool_result':
      // 工具调用完成 → 标记完成
      updateToolStatus(cardId, `✓ ${event.tool}`);
      break;
    case 'error':
      // 错误 → 红色错误卡片
      updateCardToError(cardId, event.error);
      break;
  }
}
// 循环结束 → 更新为最终完成卡片
updateCardToDone(cardId, finalContent);
```

### 流式事件与卡片映射

| SDK 事件类型 | 处理方式 |
|-------------|---------|
| `assistant`（文本输出） | 实时更新飞书卡片文本区域（500ms 防抖） |
| `tool_use`（工具调用开始） | 卡片底部状态栏显示 "⟳ 正在读取 src/index.ts..." |
| `tool_result`（工具调用完成） | 状态栏标记完成 "✓ 读取 src/index.ts" |
| 流结束 | 替换为最终结果卡片（绿色头部） |
| `error` | 显示错误卡片（红色头部） |

> 注意：以上 SDK API 为示意，实现时需以 `@anthropic-ai/claude-code` 实际版本文档为准，依赖项应锁定具体版本号。

### 防抖更新

飞书 API 有频率限制，采用 500ms 防抖策略：收到新内容后等 500ms，如果有更多内容就合并，超时才发送更新。触发频率限制时自动退避到 2s。

### 超时与取消

- 单次任务默认超时 5 分钟，可配置
- 用户发送 `/cancel` 调用 AbortController.abort() 中止任务
- 超时后自动中止并回复提示

### 并发控制

- 同一用户同一时间只允许一个活跃任务。用户发送新消息时，如果上一个任务还在执行，回复提示"上一个任务还在执行中，请等待完成或发送 /cancel 取消"
- 不同用户可以同时运行各自的任务，互不影响
- 不同用户如果操作同一个项目目录，允许并行（Claude Code 内部会处理文件锁），但卡片会提示"注意：其他用户也在操作此项目"

## 交互式卡片设计

借鉴飞书官方 OpenClaw 插件的卡片状态机设计。

### 三种状态

**思考中（Thinking）** — 蓝色头部，加载动画，无内容

**执行中（Working）** — 橙色头部，包含：
- 流式文本输出区域
- 工具调用状态记录（✓ 完成 / ⟳ 进行中）
- "取消任务"按钮

**完成（Done）** — 绿色头部（成功）或红色头部（失败），包含：
- 最终回复内容（Markdown）
- 工具调用折叠摘要
- "继续对话"、"查看详情"、"重置会话"按钮

### 危险操作确认卡片

当 Claude Code 要执行高风险操作（`rm`、`git push`、写入敏感文件等）时，暂停执行，弹出黄色确认卡片，用户点击"允许执行"或"拒绝"后继续。

### 卡片按钮事件处理

卡片中的按钮（取消任务、允许/拒绝、继续对话、重置会话等）点击后会触发 `card.action.trigger` 事件，需要单独订阅和处理：

- 订阅飞书 `card.action.trigger` 事件
- 按钮的 `action_tag` 映射到对应的处理函数
- 危险操作确认流程：SDK 调用暂停（通过 Promise 挂起）→ 弹出确认卡片 → 用户点击按钮 → resolve/reject Promise → SDK 继续或中止

| action_tag | 处理函数 |
|-----------|---------|
| `cancel_task` | 调用 AbortController.abort()，更新卡片为"已取消" |
| `confirm_danger` | resolve 确认 Promise，SDK 继续执行 |
| `reject_danger` | reject 确认 Promise，SDK 中止当前操作 |
| `reset_session` | 清除 claude_session_id，回复确认消息 |

### Markdown 适配

飞书卡片支持的 Markdown 是 CommonMark 子集，Claude Code 输出可能包含飞书不支持的语法（嵌套代码块、复杂表格等）。`cards.ts` 中需要一个 `sanitizeMarkdown()` 函数做转换：

- 嵌套代码块 → 合并为单层
- 不支持的表格 → 转为代码块展示
- 超长内容 → 截断并提示"内容过长，已截断"

## 项目管理器

### 工作区结构

```
~/workspaces/
├── .config.json              ← 预配置项目列表
├── projects/                 ← 预配置和创建的项目
│   ├── my-app/
│   └── backend-api/
└── tmp/                      ← clone 的临时项目
    └── abc123-repo-name/
```

### 配置文件

```json
{
  "projects": {
    "my-app": {
      "path": "projects/my-app",
      "description": "主应用前端",
      "defaultBranch": "main"
    }
  },
  "defaults": {
    "tmpCleanupDays": 7
  }
}
```

### 安全限制

- Claude Code 的 `cwd` 设置为 `~/workspaces/` 下的项目目录。注意：`cwd` 只设定起始目录，Claude Code 的 Bash 工具理论上仍可访问系统其他路径。对于信任的 5 人小团队，依赖 Claude Code 内置的安全策略即可。如需更强隔离，应在 Docker 容器中运行服务。
- `/project create` 名称只允许 `[a-zA-Z0-9_-]`，防止路径注入
- `/project clone` 只允许 `https://` 协议的 URL，拒绝 `file://`、`git://` 等协议，防止 SSRF。可选配置 `allowedHosts`（如 `["github.com", "gitlab.com"]`）进一步限制

## 会话管理

### 数据库 Schema

```sql
CREATE TABLE users (
  feishu_user_id TEXT PRIMARY KEY,
  name TEXT,
  active_project TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  feishu_user_id TEXT NOT NULL,
  topic_id TEXT,
  project_name TEXT NOT NULL,
  claude_session_id TEXT,
  last_active_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_message TEXT,
  assistant_message TEXT,
  tools_used TEXT,
  duration_ms INTEGER,
  status TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 会话查找逻辑

```
收到消息(user_id, topic_id, project)
    │
    ├─ 有 topic_id → 查找 WHERE feishu_user_id=? AND topic_id=? AND project_name=?
    └─ 无 topic_id → 查找 WHERE feishu_user_id=? AND topic_id IS NULL AND project_name=?
    │
    ├─ 找到 → 复用 claude_session_id（resume 上下文）
    └─ 未找到 → 创建新会话
```

### 会话生命周期

- **默认一直可 resume** — Claude Code SDK 的 sessionId 对应本地对话历史文件，无 TTL 限制
- **只有两种方式结束会话：** 用户主动 `/reset`，或切换到不同项目
- **旧会话保留** — 切换项目后旧会话不删除，切回来还能继续

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| Claude Code SDK 调用失败 | 红色错误卡片，显示错误信息，提供"重试"按钮 |
| 项目路径不存在 | 提示用户检查项目配置或重新 clone |
| 飞书 API 频率限制 | 自动降低卡片更新频率（防抖从 500ms 增加到 2s） |
| 飞书卡片更新失败 | 降级为发送新消息 |
| 用户取消任务 | AbortController.abort()，更新卡片为"已取消" |
| 会话 resume 失败 | 自动创建新会话，通知用户"上下文已重置" |
| Git clone 失败 | 提示检查 URL 或仓库权限 |

## 项目结构

```
remote-control/
├── src/
│   ├── index.ts              ← 入口，启动飞书 WebSocket 连接
│   ├── feishu/
│   │   ├── client.ts         ← 飞书 SDK 初始化和事件监听
│   │   ├── handler.ts        ← 消息路由（命令 vs 普通消息）
│   │   ├── actions.ts        ← 卡片按钮事件处理（card.action.trigger）
│   │   └── cards.ts          ← 卡片构建器（三种状态卡片 + Markdown 适配）
│   ├── claude/
│   │   ├── executor.ts       ← Claude Code SDK 调用封装
│   │   └── stream.ts         ← 流式输出处理 + 防抖更新
│   ├── session/
│   │   ├── manager.ts        ← 会话查找/创建/resume
│   │   └── db.ts             ← SQLite 初始化和查询
│   ├── project/
│   │   ├── manager.ts        ← 项目 use/clone/create/list
│   │   └── config.ts         ← 工作区配置读写
│   └── utils/
│       └── command.ts        ← 命令解析
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### 依赖项

```json
{
  "@anthropic-ai/claude-code": "latest",
  "@larksuiteoapi/node-sdk": "latest",
  "better-sqlite3": "latest",
  "dotenv": "latest",
  "pino": "latest",
  "typescript": "latest"
}
```

### 环境变量

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx
WORKSPACE_DIR=~/workspaces
ALLOWED_USER_IDS=ou_xxx1,ou_xxx2
ALLOWED_GROUP_IDS=oc_xxx1
```

## 权限规划

初期采用简单的环境变量白名单模式：

```
ALLOWED_USER_IDS=ou_xxx1,ou_xxx2,ou_xxx3
ALLOWED_GROUP_IDS=oc_xxx1
```

- 只有白名单中的用户 ID 可以使用机器人（私聊和群聊都检查）
- 只在白名单群组中响应消息
- 白名单为空时拒绝所有请求（安全默认值）

后续可扩展为分级权限：只读（问问题）vs 读写（执行代码修改）

## 运维

### 优雅关停

进程收到 SIGTERM/SIGINT 时：
1. 中止所有运行中的 Claude Code 任务（AbortController.abort）
2. 更新所有进行中的卡片为"服务重启中，请稍后重试"
3. 关闭 SQLite 连接
4. 关闭 WebSocket 连接

### 临时项目清理

服务启动时检查 `tmp/` 目录，删除超过 `tmpCleanupDays` 天未修改的目录。

### 日志

使用 `pino` 结构化 JSON 日志，输出到 stdout：
- `info`：消息收发、任务开始/完成
- `warn`：频率限制、卡片更新失败降级
- `error`：SDK 调用失败、未捕获异常

### 状态命令

`/status` — 显示当前项目、活跃会话信息、是否有任务在执行

## 参考

- [飞书官方 OpenClaw 插件](https://github.com/larksuite/openclaw-lark/) — 卡片状态机、流式更新、确认流程
- [clawdbot-feishu](https://github.com/m1heng/clawdbot-feishu) — WebSocket 连接方式、消息处理
- [OpenClaw 飞书文档](https://docs.openclaw.ai/channels/feishu) — 飞书插件技术细节
