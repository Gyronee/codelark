# 用户名解析与 @Mention 支持

**Date:** 2026-03-21
**Status:** Draft

## Goal

让 Claude 在群聊/话题中看到真实用户名而非 ID，回复时能 @mention 发消息的用户，也能主动 @mention 对话中的其他参与者。

## Scope

### In Scope

1. **用户名缓存** — 通过飞书 API 查询用户名，LRU 缓存（500 条，30 分钟 TTL）
2. **发送者名称解析** — 消息进入 pipeline 前，解析发送者真实名称
3. **群聊历史显示真实名称** — chat-history 记录真实用户名
4. **回复 @mention** — 群聊/话题中回复时自动 @发消息的用户
5. **Claude 主动 @mention** — Claude 可以在群聊/话题中 @mention 该上下文中发言过的人

### Out of Scope

- @mention 未发言过的群成员（需要额外 API 查群成员列表）
- @所有人功能
- 用户头像获取

## Architecture

### 用户名缓存

新增模块 `src/messaging/inbound/user-name-cache.ts`：

- 调用飞书 API `GET /open-apis/contact/v3/users/:user_id`（单个）或批量接口
- LRU 缓存：最多 500 条，TTL 30 分钟
- 查询失败时缓存空字符串，避免反复重试
- 导出 `resolveUserName(userId): Promise<string>`

### 名称解析时机

在 `event-handlers.ts` 的消息处理 pipeline 中，parse 之后、dispatch 之前：

```
parse → 解析 senderName → recordMessage(用真实名称) → gate → dispatch
```

当前 `ctx.senderName` 实际上始终为 null（飞书 IM 事件的 `sender.sender_id` 只包含 `open_id`/`user_id`/`union_id`，不含 `name`），所以 chat-history 一直在用 `senderId` 作为发送者名称。解析后用缓存的真实名称替换。

### 回复 @mention（自动）

群聊/话题中 bot 回复时，自动在消息内容前加 @mention 标记指向发消息的用户：

- 群聊非话题：@发消息的用户（多人共享 session，标识回复给谁）
- 群聊话题：@发消息的用户（同上）
- 单聊：不 @（没必要）

### Claude 主动 @mention

chat-history 中已经记录了每个发言者的 senderName 和 senderId。在群聊/话题中注入 prompt 上下文时：

1. 从 chat-history 提取发言过的用户列表（去重）
2. 在 prompt 上下文中注入可用 mention 用户列表：`[可 @mention 的用户: 张三, 李四]`
3. 告诉 Claude 用 `@用户名` 格式引用用户
4. 在 bot 输出时，将 `@用户名` 替换为飞书的 mention 语法

**数据来源：** chat-history 目前只记录 `senderName` 和 `text`，不含 `senderId`。需要给 `HistoryEntry` 加 `senderId` 字段，这样才能构建 name → userId 的反向映射。加了之后不需要额外 API 调用。

### 输出侧 mention 替换

Claude 的回复文本中如果包含 `@用户名`，在发送给飞书之前替换为对应的 mention 格式。需要一个 `name → userId` 的反向映射，从 chat-history 构建。

替换逻辑：
1. 从 chat-history 获取 `{ senderName, senderId }` 对
2. 构建 `Map<name, userId>`
3. 扫描 Claude 输出文本，把 `@张三` 替换为 `<at user_id="ou_xxx">张三</at>`（文本消息）或 `<at id=ou_xxx></at>`（卡片 markdown）

## @Mention 格式

飞书文本消息和卡片消息的 @mention 格式不同：

**文本消息：**
```
<at user_id="ou_xxx">用户名</at>
消息正文
```

**卡片 markdown：**
```
<at id=ou_xxx></at>
markdown 正文
```

@mention 在卡片中放在**独立的 markdown 元素**里（在 streaming content 元素之前），不嵌入 streaming 内容本身。这样避免 streaming 过程中被覆盖。IM fallback 卡片同理——在 elements 数组头部加 mention 元素。

## 新增模块

| 模块 | 职责 |
|------|------|
| `src/messaging/inbound/user-name-cache.ts` | 飞书用户名查询 + LRU 缓存 |

## 变更模块

| 模块 | 变更 |
|------|------|
| `src/messaging/inbound/event-handlers.ts` | parse 后解析 senderName |
| `src/channel/chat-history.ts` | HistoryEntry 增加 senderId 字段；导出 getActiveUsers() 提取发言用户列表 |
| `src/messaging/inbound/dispatch.ts` | 群聊 prompt 注入可 mention 用户列表；回复时传入 mention 信息；输出侧 mention 替换 |
| `src/messaging/outbound/send.ts` | sendText/sendCard 支持 mention 参数 |
| `src/card/streaming-card.ts` | streaming card 创建时支持 mention 元素 |
| `src/card/builder.ts` | 完成卡片（done/error/cancelled）在 elements 头部加 mention 元素 |

## 重名处理

如果两个用户同名（如两个"张伟"），`name → userId` 映射会冲突。处理方式：**跳过替换**——当检测到重名时，`@张伟` 不替换为 mention 语法，保留为纯文本。不做错误 mention 比 mention 错人好。

## Mention 数据流

```
event-handlers.ts
  → resolveUserName(ctx.senderId) → ctx.senderName = "张三"
  → recordMessage(chatId, "张三", text, threadId, ctx.senderId)   // senderId 存入 history

dispatch.ts handleClaudeTask()
  → 构造 mentionTarget = { userId: ctx.senderId, name: ctx.senderName }  // 自动 @发消息的人
  → 从 chat-history 提取 activeUsers 注入 prompt
  → new StreamingCard(chatId, threadId, messageId, mentionTarget)  // 传入 mention 目标
  → executeClaudeTask(prompt, ...)

StreamingCard
  → ensureCardCreated() 时在 card body 头部加 mention 元素
  → complete()/abort()/error() 调 CardBuilder 时传入 mentionTarget
  → fallbackText() 时在文本前加 mention 标记

CardBuilder
  → done()/error()/cancelled() 接收 mentionTarget，在 elements 头部加 mention markdown

dispatch.ts onComplete callback
  → Claude 输出文本经过 replaceMentions(text, nameToUserIdMap) 替换 @用户名
  → 传入 CardBuilder 的文本已替换完成
```

## Constraints

- 飞书 contact API 需要 `contact:user.base:readonly` 权限
- 用户名查询使用 `open_id` 类型（与飞书 IM 事件一致）
- 查询失败时缓存空字符串，回退显示 open_id
- @mention 只在群聊中使用，单聊不 @
- Claude 只能 @mention 当前上下文中发言过的用户
- 输出侧 mention 替换基于精确名字匹配，重名时跳过不替换
