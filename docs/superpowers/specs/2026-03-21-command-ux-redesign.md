# 命令体系与权限模型重构

**Date:** 2026-03-21
**Status:** Draft

## Goal

理清 project 和 session 的边界，统一权限模型，优化群聊体验。让两类用户（本地 CLI 用户 + 纯 bot 用户）都有清晰自然的使用体验。

## 两类用户场景

- **场景 A（CLI 用户）**：本地有 Claude Code CLI，bot 是远程遥控器，恢复本地 session 继续干活
- **场景 B（纯 bot 用户）**：没有本地 CLI，bot 是唯一入口，从 `/project create` 开始，完全通过 bot 开发

## 命令结构

### /project — 工作目录管理

| 命令 | 说明 |
|------|------|
| `/project list` | 列出用户有权限的所有项目（合并 bot 创建 + 本地 CLI 项目） |
| `/project use <项目名>` | 切换到指定项目，开始新对话。如果该项目有 CLI session，提示可用 `/session resume` |
| `/project create <名称>` | 创建新空项目（创建者自动拥有权限） |
| `/project clone <地址>` | 克隆 Git 仓库（创建者自动拥有权限） |
| `/project home` | 切回个人目录 |
| `/project grant <用户>` | 授权指定用户访问当前项目（创建者或管理员可用） |
| `/project grant <用户> <项目>` | 授权指定用户访问指定项目（管理员可用） |
| `/project revoke <用户>` | 撤销指定用户对当前项目的权限 |
| `/project revoke <用户> <项目>` | 撤销指定项目权限（管理员可用） |
| `/project access` | 查看当前项目的授权列表 |

### /session — CLI 对话恢复

| 命令 | 说明 |
|------|------|
| `/session list` | 列出用户有权限的本地 CLI 会话 |
| `/session resume <ID>` | 恢复指定 CLI 会话（需要对应项目的权限） |
| `/session exit` | 退出恢复模式，回到正常 bot 会话 |

### 其他命令

| 命令 | 说明 |
|------|------|
| `/help` | 动态帮助——基于本地信息只展示用户当前有权限的命令 |
| `/status` | 查看当前状态（项目、任务、恢复会话） |
| `/whoami` | 查看 open_id |
| `/reset` | 重置当前对话上下文（受权限控制） |
| `/cancel` | 取消正在执行的任务 |
| `/model` | 查看/切换模型 |
| `/file <path>` | 获取当前项目文件（需要项目权限） |
| `/auth` | 飞书 OAuth 授权 |

## `/project list` 统一展示

合并两个数据来源：

1. **Bot 项目**：`projects.json` 中通过 `/project create` 或 `/project clone` 创建的项目
2. **本地 CLI 项目**：`~/.claude/projects/` 下有 session 的项目（去重，按项目 cwd 聚合）

展示效果（卡片 markdown）：

```
📋 项目列表

1. remote-control (本地)
    最近会话: "飞书插件" · 1分钟前

2. LawAssistant (本地)
    最近会话: "法条大全方案设计" · 1分钟前

3. my-new-app (Bot)
    通过 /project create 创建
```

只展示用户有权限的项目。

## 统一权限模型

### 权限层级

所有项目操作（project use、session resume、file 获取等）共用一套权限：**用户对项目的访问权限**。

### 自动授权（无需配置）

- 用户的**个人目录**（`users/ou_xxx/`）— 自动有权限
- 用户**自己创建/clone 的项目** — 创建者自动有权限

### 配置授权

**配置文件：`access.json`**（位于 workspace 根目录）

```json
{
  "projects": {
    "remote-control": {
      "allowedUsers": ["ou_xxx", "ou_yyy"]
    },
    "LawAssistant": {
      "allowedUsers": ["ou_xxx"]
    },
    "*": {
      "allowedUsers": ["ou_admin"]
    }
  }
}
```

`"*"` 表示所有项目的通配权限。

**管理方式：**
- 手动编辑 `access.json` 文件
- `/project grant` / `/project revoke` 命令（直接修改 `access.json`）
- 每次权限检查时读取文件（修改立即生效，无需重启）

### 权限操作的权限

| 操作 | 谁能执行 |
|------|---------|
| `/project grant/revoke` 任意项目 | 管理员（`ADMIN_USER_IDS`） |
| `/project grant/revoke` 自己创建的项目 | 项目创建者 |
| `/project grant/revoke` 其他项目 | 无权限 |

### 配置项

`.env` 新增：
```
ADMIN_USER_IDS=ou_xxx,ou_yyy
```

与 `ALLOWED_USER_IDS`（谁能用 bot）完全独立。

## 群聊模型

### Project 归属

| 场景 | Project |
|------|---------|
| 群内非话题消息 | 群 home project（自动创建的群专属目录，类似用户个人目录） |
| 群内话题（thread） | 可通过 `/project use` 绑定一个项目（一次性），未绑定时使用群 home project |

### 话题内 `/project use` 规则

- 话题发起者或群管理员可以绑定项目（仅限一次）
- 绑定时自动清空对话上下文（重新开始）
- 已绑定后不可再切换（管理员除外）
- 未绑定时 @bot 正常对话，使用群 home project

### Session 隔离规则

| 场景 | Session 归属 | 说明 |
|------|-------------|------|
| 单聊 | per-user | 每个用户独立 session |
| 群内话题（thread） | per-thread | 话题内所有人共享一个 session，协作同一上下文 |
| 群内非话题消息 | per-group | 整个群共享一个闲聊 session |

话题和群主消息流天然隔离（按 threadId），互不可见。

### `/reset` 权限

| 场景 | 谁能 reset |
|------|-----------|
| 单聊 | 用户自己 |
| 群内非话题 | 飞书群管理员 |
| 群内话题 | 飞书群管理员 + 话题发起者 |

### 群内 `/project use` 权限

非话题：群管理员或 bot 管理员（对所有人生效）。
话题内：话题发起者或群管理员（仅限一次绑定）。

### 群管理员查询

- 通过飞书 API `GET /open-apis/im/v1/chats/{chat_id}/members` 获取成员角色
- **缓存 30 分钟**，只在执行敏感操作（reset、project use、grant/revoke）时触发 API 查询
- `/help` 基于本地信息（ADMIN_USER_IDS + 项目创建者 + 缓存中的群管理员）判断，**不触发 API 调用**

## 动态 /help

`/help` 根据用户当前权限动态展示可用命令：

- 基于本地信息判断：`ADMIN_USER_IDS`、项目创建者、缓存中的群管理员角色
- 不触发飞书 API 调用（响应快）
- 宁可多展示：缓存未命中时不隐藏命令，用户执行时再检查真实权限

示例：普通用户在别人项目里看不到 `/project grant`；管理员能看到全部命令。

## 改动范围

### 新增

| 模块 | 说明 |
|------|------|
| `src/auth/access.ts` | 统一权限检查：读取 access.json + 检查创建者 + 检查个人目录 |
| `access.json` | 项目访问权限配置文件 |

### 变更

| 模块 | 变更 |
|------|------|
| `src/config.ts` | 新增 `ADMIN_USER_IDS` 配置 |
| `src/messaging/inbound/dispatch.ts` | `/project list` 合并两个来源；`/project grant/revoke/access` 命令；所有项目操作加权限检查；动态 `/help`；`/reset` 权限检查 |
| `src/session/local-sessions.ts` | `listLocalSessions` 支持按项目权限过滤 |
| `src/messaging/inbound/event-handlers.ts` | 群聊 session 隔离规则变更（thread=共享，非话题=群共享） |
| `src/session/db.ts` | sessions 表新增 `chat_id` 列支持群共享 session；话题绑定项目的存储 |
| `src/session/manager.ts` | 适配群聊共享 session（用 chatId 而非 userId 作为 key） |
| `src/messaging/outbound/send.ts` | 新增获取群成员角色的 API 调用（带 30 分钟缓存） |
| `src/project/manager.ts` | 项目记录创建者信息 |

## Constraints

- `access.json` 每次权限检查时读取，不缓存（修改立即生效）
- 飞书群管理员查询缓存 30 分钟，只在敏感操作时触发
- 本地 CLI 项目没有"创建者"概念，只能通过 access.json 授权
- 群聊共享 session 改动影响现有行为（从 per-user 变为 per-group/per-thread），需要通知现有用户
- 现有群聊 per-user session 在迁移后将被孤立（不影响新行为，旧数据自然过期）
- 群 home project 自动创建，命名规则：`group-<chatId 后 8 位>`
