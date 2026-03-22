# CodeLark

[English](./README.md) | [中文](./README.zh-CN.md)

把飞书群聊变成完整的 Claude Code 工作区。

CodeLark 通过 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) 将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 接入飞书，让团队直接在聊天中使用 Claude 的编程能力 —— 文件读写、Shell 命令、项目管理，以及深度飞书文档集成。

## 为什么选 CodeLark？

- **群聊即终端** — 在飞书里直接读写文件、执行命令、管理 Git 仓库
- **实时流式输出** — CardKit 2.0 流式卡片，实时展示思考过程、工具调用状态和内容生成
- **飞书原生文档工具** — 创建、读取、更新云文档；管理知识库；全文搜索 —— 基于 OAuth 用户授权
- **多项目工作区** — 创建项目、克隆仓库、切换上下文；每个群话题可绑定独立项目
- **团队协作** — 用户白名单、项目级权限控制、管理员角色、话题隔离

## 功能

### AI 与代码执行
- **Claude Opus / Sonnet / Haiku** — 通过 `/model` 按会话切换模型
- **完整 Claude Code 工具集** — Read、Write、Edit、Bash、Glob、Grep
- **扩展思维** — 推理过程在折叠面板中展示，与最终回答分离
- **会话管理** — 恢复本地 CLI 会话、命名会话、按项目隔离
- **MCP 插件支持** — 自动加载本地缓存的 Claude Code 插件

### 消息处理
- **文本、图片、文件、富文本（Post）消息** — 图片作为多模态内容发送给 Claude
- **引用/回复上下文** — 被引用消息的媒体和文本自动合并到当前请求
- **群聊上下文感知** — 最近 20 条消息 / 30 分钟内的聊天记录作为上下文
- **斜杠命令** — `/help`、`/status`、`/cancel`、`/model`、`/project`、`/session`、`/file`、`/auth`、`/whoami`

### 飞书文档集成（MCP + OAuth）
- **云文档** — 使用飞书风格 Markdown 创建文档（高亮块、分栏、表格、Mermaid、图片），读取为 Markdown，7 种编辑模式
- **知识库** — 列出/创建知识空间和节点，自动转换知识库 URL
- **云盘** — 列表、复制、移动、删除、上传（大文件分片）、下载
- **搜索** — 文档与知识库统一搜索，支持按创建者、类型、时间范围过滤
- **评论** — 列出、创建、解决文档评论
- **媒体** — 向文档中插入图片/文件，下载附件

### 流式卡片
- **CardKit 2.0** 流式模式 — 实时内容更新
- **分阶段展示** — 思考面板、工具执行状态、主内容作为独立流
- **优雅降级** — CardKit 不可用时自动切换为标准 IM 卡片
- **输入指示** — 处理中在用户消息上显示输入反应

### 安全与权限
- **用户和群白名单** — 可选的授权用户/群组过滤
- **项目级 ACL** — `access.json` 白名单，创建者自动授权
- **管理员角色** — 不受限访问所有项目和操作
- **话题权限** — 仅管理员/创建者可重命名或重置会话
- **路径穿越防护** — realpath 解析，沙盒限制在项目目录内
- **OAuth 身份验证** — 防止跨用户授权劫持
- **工具权限确认** — 危险操作需用户通过卡片按钮审批（60 秒超时自动拒绝）

### 可靠性
- **事件去重** — 基于事件 ID，12 小时 TTL，过期消息过滤（>2 分钟）
- **按聊天消息队列** — 串行处理防止响应交错
- **频率限制** — 卡片更新节流（CardKit 100ms / IM 回退 1.5s），可配置防抖
- **OAuth 令牌管理** — 自动刷新，临时错误重试，提前 60 秒刷新
- **优雅关闭** — SIGINT/SIGTERM 处理，中止所有活跃任务，等待进行中的卡片更新

## 核心概念

CodeLark 有三个核心概念需要了解：

### 工作目录

每次和 Claude 对话都在服务器上的一个目录中进行。Claude 可以在这个目录里读写文件、执行命令 —— 就像在本地使用 Claude Code 一样。

- **私聊（未选择项目）** — 自动分配个人默认目录（`users/<你的ID>/`），首次使用时自动创建
- **群话题（未绑定项目）** — 自动分配群组默认目录（`groups/<群ID>/`），同群所有话题共享
- **选择了项目** — Claude 在该项目的目录下工作

### 项目

项目是一个**命名的工作目录**，跨对话持久存在，可以与其他用户共享。

```
/project create my-app        # 创建空项目（自动 git init）
/project clone https://...    # 克隆仓库为项目
/project use my-app           # 切换到某个项目（仅私聊）
/project list                 # 列出可用项目
/project grant my-app ou_xxx  # 授权其他用户访问
```

**在私聊中**，通过 `/project use` 切换项目。你的选择会被记住 —— 下次发消息时仍然在同一个项目中。

**在群话题中**，项目绑定到话题。话题中首次执行 `/project use` 后即锁定，之后不可更改，确保话题的对话历史与工作目录保持一致。

### 会话

会话是 Claude 记住的**对话上下文**（聊天记录）。

- **Bot 会话** — 自动创建。私聊中每个用户每个项目一个会话，群聊中每个话题一个会话。使用 `/new` 清空上下文重新开始。
- **CLI 会话** — 如果你也在本地使用 Claude Code，可以通过 `/session resume <ID>` 在飞书中恢复本地 CLI 会话，继续在终端中开始的工作。使用 `/session list` 查看可用的本地会话，`/session exit` 返回正常模式。

### 如何协同工作

```
私聊：
  你 → 机器人                     使用你选择的项目（或个人默认目录）
                                 每个项目一个会话，/new 重置

群聊：
  话题 A → 绑定 my-app            每个话题有独立会话
  话题 B → 绑定 api-server        每个话题可绑定不同项目
  话题 C → 未绑定项目              使用群组默认目录
```

## 快速开始

### 前置条件

- Node.js >= 20
- 一个有机器人能力的飞书自建应用（[去创建](https://open.feishu.cn/app)）
- Claude 订阅或 Anthropic API Key

### 1. 克隆并安装

```bash
git clone https://github.com/anthropics/codelark.git
cd codelark
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
WORKSPACE_DIR=~/workspaces

# 可选：API Key 认证（不设则使用 Claude 订阅）
# ANTHROPIC_API_KEY=sk-ant-xxxxx

# 可选：限制访问
ALLOWED_USER_IDS=ou_xxx1,ou_xxx2
ALLOWED_GROUP_IDS=oc_xxx1

# 可选：准确的群内 @提及检测
# BOT_OPEN_ID=ou_xxxxx
```

### 3. 配置飞书应用

在[飞书开放平台控制台](https://open.feishu.cn/app)中：

1. **机器人** — 启用机器人能力
2. **事件订阅** — 启用 WebSocket 模式（长连接），订阅以下事件：
   - `im.message.receive_v1` — 接收消息
   - `card.action.trigger` — 卡片按钮回调
3. **权限** — 添加以下权限：
   - `im:message` / `im:message:send_as_bot` — 读取和发送消息
   - `im:chat` / `im:chat:readonly` — 访问会话信息
   - `im:resource` — 下载媒体（图片、文件）
   - `contact:user.base:readonly` — 解析用户名

### 4. 启动

```bash
# 开发环境（热重载）
npm run dev

# 生产环境
npm run build && npm start
```

机器人通过 WebSocket 连接 — 无需公网服务器或域名。

### 5. 首次使用

1. 私聊机器人发送 `/whoami` 获取你的 `open_id`
2. 将 `open_id` 添加到 `.env` 的 `ALLOWED_USER_IDS`（如启用了白名单）
3. 发送 `/auth` 授权飞书文档访问（OAuth 设备授权流程）
4. 开始对话 — 或使用 `/help` 查看所有命令

## 命令列表

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/status` | 当前项目和任务状态 |
| `/whoami` | 获取你的 open_id |
| `/cancel` | 取消正在执行的任务 |
| `/model [opus\|sonnet\|haiku]` | 切换模型或查看当前模型 |
| `/project list` | 列出可用项目 |
| `/project use <名称>` | 切换到指定项目 |
| `/project create <名称>` | 创建新项目 |
| `/project clone <URL>` | 克隆 Git 仓库 |
| `/project grant <名称> <用户ID>` | 授予项目访问权限 |
| `/project revoke <名称> <用户ID>` | 撤销项目访问权限 |
| `/session list` | 列出最近的会话 |
| `/session resume <ID>` | 恢复本地 CLI 会话 |
| `/session rename <名称>` | 重命名当前会话 |
| `/session new` 或 `/new` | 开始新会话 |
| `/file <路径>` | 从项目上传文件 |
| `/auth` | 授权飞书文档访问 |

## 配置项

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `FEISHU_APP_ID` | 是 | — | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 是 | — | 飞书应用密钥 |
| `WORKSPACE_DIR` | 是 | — | 项目和数据的根目录 |
| `ANTHROPIC_API_KEY` | 否 | — | API Key（不设则使用 Claude 订阅） |
| `ALLOWED_USER_IDS` | 否 | — | 用户白名单，逗号分隔的 open_id |
| `ALLOWED_GROUP_IDS` | 否 | — | 群组白名单，逗号分隔的 chat_id |
| `BOT_OPEN_ID` | 否 | — | 机器人的 open_id，用于准确的 @提及检测 |
| `ADMIN_USER_IDS` | 否 | — | 管理员白名单，逗号分隔的 open_id（完全访问权限） |
| `TASK_TIMEOUT_MS` | 否 | `300000` | 任务最大执行时间（5 分钟） |
| `DEBOUNCE_MS` | 否 | `500` | 消息处理防抖时间 |
| `SESSION_TITLED_ONLY` | 否 | `false` | 会话列表仅显示已命名的会话 |
| `LOG_LEVEL` | 否 | `info` | 日志级别（`info` 或 `debug`） |

## 技术栈

- **运行时** — Node.js + TypeScript (ES2022)
- **AI** — [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk) + [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **飞书** — [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)
- **数据库** — SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（WAL 模式）
- **日志** — [pino](https://github.com/pinojs/pino)（结构化 JSON）
- **校验** — [zod](https://github.com/colinhacks/zod)
- **测试** — [vitest](https://vitest.dev/)

## 开发

```bash
# 运行测试
npm test

# 监听模式
npm run test:watch

# 开发服务器（热重载）
npm run dev
```

## 致谢

CodeLark 的飞书文档集成（云文档、知识库、云盘、搜索、评论）大量参考了 [openclaw-lark](https://github.com/larksuite/openclaw-lark) —— 字节跳动 Lark 开放平台团队开源的 OpenClaw 官方飞书插件。感谢 Lark 开放平台团队的开源贡献。

## 许可证

MIT
