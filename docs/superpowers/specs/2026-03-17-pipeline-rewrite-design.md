# 子项目 1：核心消息管线重写 设计文档

## 概述

将飞书机器人的消息处理从单体 handler（300+ 行）重构为参考 `@larksuite/openclaw-lark` 官方插件的 7 阶段管线架构。保留已验证的底层模块（session、project、claude executor、config），重写消息处理和卡片系统。

## 背景与动机

当前实现存在以下问题（在调试过程中发现）：

1. **并发消息交错** — 同一对话的多条消息可能同时处理，导致卡片更新混乱
2. **去重不健壮** — 无界 Map + O(n) 全扫描，进程重启后丢失去重记录导致旧消息重放
3. **处理了不属于自己的事件** — 未校验 `app_id`
4. **取消响应慢** — 取消指令需排队等当前任务完成
5. **卡片更新无 mutex** — 并发 API 调用可能导致状态不一致
6. **卡片创建失败静默丢弃** — 用户看不到任何回复
7. **@mention 处理脆弱** — 正则匹配 `/@_user_\d+/g` 不够健壮

## 架构

### 消息管线

```
飞书 WebSocket 事件
    │
    ▼
① event-handlers ── app_id 校验 + 快速取消检测
    │
    ▼
② dedup ── 有界 FIFO Map（5000 条）+ create_time 过期
    │
    ▼
③ parse ── 解析内容 + 构建 MentionInfo + 去除 bot mention
    │
    ▼
④ gate ── 群白名单 + 用户白名单 + @bot 检查（/whoami 绕过）
    │
    ▼
⑤ chat-queue ── 按 chatId:threadId 串行入队
    │
    ▼
⑥ dispatch ── 解析命令或调用 Claude Code SDK
    │
    ▼
⑦ reply-dispatcher ── 流式卡片 / 静态文本 / 降级回复
```

### 卡片流式系统

**状态机：**

```
idle → creating → streaming → completed
                           → aborted
                           → error
               → creation_failed → 降级为纯文本
```

**三个模块：**

- `streaming-card.ts` — 卡片生命周期状态机，带 epoch 防过期创建
- `flush-controller.ts` — mutex 保护的 flush，`needsReflush` 保证最后状态一定刷出，长间隔后首次更新延迟批量
- `card-builder.ts` — 构建卡片 JSON（思考中/执行中/完成/错误/确认/取消），支持思考过程折叠面板

### 串行队列

`chat-queue.ts` — 按 `chatId:threadId` 维护 Promise 链：
- 同一对话串行执行，不同对话互不阻塞
- 任务完成后自清理 key
- 与活跃任务注册表（`active-registry.ts`）分离，支持快速取消查询

### 快速取消

取消指令不入队，在 `event-handlers.ts` 直接执行：
- 检测到取消文本 → 查找活跃任务注册表 → 立即 abort + 停止卡片更新
- 毫秒级响应，不等队列排空

## 文件结构

### 保留的模块（微调 import 路径）

```
src/config.ts                    ← 环境变量加载
src/logger.ts                    ← pino 日志
src/session/db.ts                ← SQLite 数据库层
src/session/manager.ts           ← 会话管理
src/project/config.ts            ← 工作区配置
src/project/manager.ts           ← 项目管理
src/claude/executor.ts           ← Claude Code SDK 调用（ToolStatus import 改为从 card/builder.ts）
src/utils/command.ts             ← 命令解析
```

### 重写/新增的模块

```
src/messaging/
  inbound/
    event-handlers.ts            ← 事件校验 + app_id 检查 + 快速取消
    dedup.ts                     ← 有界 FIFO 去重（5000 条上限 + 定期清理）
    parse.ts                     ← 消息解析 + MentionInfo 构建
    gate.ts                      ← 权限门控
    dispatch.ts                  ← 命令/Claude 分发 + 编排
    card-actions.ts              ← 卡片按钮回调 + pendingPermissions
  outbound/
    send.ts                      ← sendText / sendCard / updateCard
  types.ts                       ← MessageContext 等共享类型

src/card/
  streaming-card.ts              ← 卡片生命周期状态机
  flush-controller.ts            ← mutex flush + 节流
  builder.ts                     ← 卡片 JSON 构建

src/channel/
  chat-queue.ts                  ← 按 chat 串行队列（Promise chain）
  active-registry.ts             ← 活跃任务注册表

src/index.ts                     ← 入口重写（接入新管线）
```

### 删除的模块

```
src/feishu/handler.ts            ← 被 messaging/inbound/* 替代
src/feishu/client.ts             ← 被 messaging/outbound/send.ts 替代
src/feishu/actions.ts            ← 被 event-handlers.ts 吸收
src/feishu/cards.ts              ← 被 card/* 替代
src/claude/stream.ts             ← 被 card/flush-controller.ts 替代
```

## 各模块详细设计

### messaging/types.ts — 共享类型

```typescript
export interface MentionInfo {
  key: string;       // "@_user_1"
  openId: string;
  name: string;
  isBot: boolean;
}

export interface MessageContext {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  threadId: string | null;      // 话题 ID（root_id）
  senderId: string;             // open_id
  senderName: string | null;
  text: string;                 // 去除 bot mention 后的纯文本
  rawText: string;              // 原始文本
  messageType: string;          // text, image, etc.
  mentions: MentionInfo[];
  botMentioned: boolean;
  createTime: number;           // 毫秒时间戳
  appId: string;
}
```

### messaging/inbound/event-handlers.ts

```
注册 im.message.receive_v1 事件处理器

收到事件:
  1. 校验 app_id === 配置的 FEISHU_APP_ID，不匹配则忽略
  2. 提取原始文本，检测是否是取消指令（/cancel）
     - 是 → 查 active-registry，找到则立即 abort，不入队
  3. 调用 dedup.check(eventId, createTime)
     - 重复 → 忽略
  4. 调用 parse(data) → MessageContext
  5. 调用 gate(ctx, config)
     - 拒绝 → 忽略（/whoami 绕过门控）
  6. 入队 chat-queue.enqueue(queueKey, task)
```

### messaging/inbound/dedup.ts

```
有界 FIFO Map:
  - 容量上限 5000 条
  - 超出时删除最早的 key（Map 迭代顺序 = 插入顺序）
  - 定期清理过期条目（5 分钟间隔，timer.unref()）

双重检查:
  1. event_id 是否已见过（Map 查找）
  2. create_time 是否超过 120 秒（防进程重启后旧消息重放，120s 窗口容忍时钟偏差）

导出:
  - check(eventId: string, createTime: number): boolean  // true = 应处理
  - destroy(): void  // 停止定时器
```

### messaging/inbound/parse.ts

```
输入: 飞书事件 data 对象
输出: MessageContext

处理:
  1. 从 message.mentions 构建 MentionInfo[]
     - 每个 mention 标记 isBot（通过比对 bot 的 open_id）
  2. 确定 bot 是否被 @（botMentioned）
  3. 从 content.text 中移除所有 mention key（安全转义后正则替换）
  4. 提取 senderId（优先 open_id，fallback user_id）
  5. 构建完整 MessageContext
```

### messaging/inbound/gate.ts

```
输入: MessageContext + Config
输出: 'pass' | 'reject'

规则:
  1. /whoami → 始终 pass（绕过所有检查）
  2. 用户白名单: allowedUserIds 非空时，senderId 必须在列表中
  3. 群聊:
     a. allowedGroupIds 非空时，chatId 必须在列表中
     b. 必须 botMentioned（飞书通常只推送 @bot 的消息，此为兜底）
  4. 私聊: 通过用户白名单即可
```

### messaging/inbound/dispatch.ts

```
接收 MessageContext，决定执行路径:

  0. db.upsertUser(senderId, senderName) — 记录用户
  1. 解析命令（parseCommand）
     - /help, /status, /whoami, /reset, /project *
     - /cancel: 此处为 fallback（快速取消未命中时），回复"没有正在执行的任务"
     - 命令直接执行，通过 send.ts 回复文本
  2. 非命令 → Claude Code 任务:
     a. 获取/创建会话（SessionManager）
     b. 解析项目路径（ProjectManager / 默认用户目录）
     c. 创建 ReplyDispatcher（流式卡片）
     d. 注册到 active-registry
     e. 调用 executeClaudeTask，回调接入 ReplyDispatcher
     f. 完成后从 active-registry 移除
```

### channel/chat-queue.ts

```
Map<string, Promise<void>> — Promise 链实现串行队列

buildQueueKey(chatId, threadId):
  - 有 threadId: `${chatId}:thread:${threadId}`
  - 无 threadId: `${chatId}`

enqueue(key, task):
  - 取当前链尾 Promise（或 Promise.resolve()）
  - 新 Promise = prev.then(task, task)  // 即使前一个失败也继续
  - 存入 Map
  - 任务完成后，如果 Map 中的 Promise 仍是自己，删除 key

导出:
  - enqueue(key: string, task: () => Promise<void>): void
  - hasActiveTask(key: string): boolean
```

### channel/active-registry.ts

```
key = chatQueue 的 queueKey（即 chatId 或 chatId:thread:threadId）
快速取消通过 buildQueueKey(chatId, threadId) 构造相同的 key 来查找。

Map<string, ActiveDispatcher>

interface ActiveDispatcher {
  abortController: AbortController;
  abortCard: () => void;    // 立即停止卡片流式更新
  userId: string;           // 记录是谁的任务
}

set(key, dispatcher): 注册
get(key): 查找
getByUserId(userId): 查找该用户在任何 chat 中的活跃任务
delete(key): 移除
abortAll(): 关停时全部中止
```

注意：同一用户只允许一个活跃 Claude 任务。dispatch.ts 在启动任务前先调用
`getByUserId(userId)` 检查，如果已有活跃任务则提示用户等待或取消。

### card/streaming-card.ts

```
状态机管理卡片生命周期:

属性:
  - phase: idle | creating | streaming | completed | aborted | error | creation_failed
  - cardMessageId: string | null
  - createEpoch: number（防过期创建）

方法:
  - async create(chatId, thinkingCard)
    → phase: idle → creating
    → 调用 send.sendCard()
    → 成功: phase → streaming, 记录 cardMessageId
    → 失败: phase → creation_failed, 触发降级
  - async update(card)
    → 仅在 streaming phase 执行
    → 通过 FlushController 节流
  - async complete(card)
    → flush + 最终更新 + phase → completed
  - async abort(card)
    → phase → aborted + 更新卡片
  - async error(card)
    → phase → error + 更新卡片
  - fallbackText(chatId, text)
    → creation_failed 时降级为纯文本消息
```

### card/flush-controller.ts

```
mutex 保护的卡片更新:

属性:
  - flushInProgress: boolean
  - needsReflush: boolean
  - pendingContent: string | null
  - lastUpdateTime: number
  - throttleMs: number

schedule(content):
  - pendingContent = content
  - 如果 flushInProgress → needsReflush = true, return
  - 如果距上次更新 < throttleMs → 设定 timer, return
  - 长间隔检测: 如果距上次 > 2000ms → 延迟 200ms 批量（避免只显示 1-2 字符）
  - 否则立即 flush()

flush():
  - flushInProgress = true
  - 取 pendingContent, 清空
  - 调用 updateFn(content)
  - flushInProgress = false
  - 如果 needsReflush → needsReflush = false, setTimeout(0, flush)

waitForFlush(): Promise<void>
  - 等待当前进行中的 flush 完成

destroy():
  - 清除 timer
```

### card/builder.ts

```
在现有 CardBuilder 基础上增强:

1. CardKit 2.0 格式支持:
   - schema: "2.0", body.elements 而非顶层 elements
   - 流式更新区域使用 element_id = 'streaming_content'

2. 思考过程折叠面板:
   - collapsible_panel 元素，默认折叠
   - 显示思考时长（"思考了 3.2s"）

3. Feed 预览摘要:
   - summary.content 填充截断后的纯文本（120 字符）
   - 出现在飞书通知预览中

4. 创建失败降级:
   - buildFallbackText(text): 将 Markdown 转为纯文本消息
```

### messaging/inbound/card-actions.ts（新增）

```
处理卡片按钮点击回调（confirm/reject/cancel/reset）。

当前限制：飞书 Node SDK 的 WSClient 不支持 cardActionHandler（等待 SDK 更新）。
临时方案：卡片按钮不注册回调，危险操作确认使用 canUseTool 的 allowedTools 白名单控制。

pendingPermissions Map 保留在此模块中，供 executor 的 onPermissionRequest 回调使用：
  - requestPermission(taskId): Promise<boolean>
    → 创建 Promise + 60s 超时自动 deny
  - resolvePermission(taskId, allowed): void
    → 解析 Promise

注意：当飞书 Node SDK 支持长连接卡片回调后，在此模块注册
card.action.trigger handler，调用 resolvePermission 完成闭环。
```

### messaging/outbound/send.ts

```
从现有 feishu/client.ts 提取，增加:

1. initFeishuClient(config) → { client, wsClient }
2. sendText(chatId, text, threadId?): 发送文本消息（支持回复到话题）
3. sendCard(chatId, card, threadId?): 发送卡片，返回 messageId | null
4. updateCard(messageId, card): 更新卡片内容，返回 boolean（成功/失败）
5. startWebSocket(eventDispatcher): 启动长连接

返回值约定:
  - sendCard: 成功返回 messageId（string），失败返回 null → streaming-card 转 creation_failed
  - updateCard: 成功返回 true，失败返回 false → flush-controller 可判断是否需降级
  - sendText: 无返回值，错误 catch + log
```

### index.ts 重写

```
入口串联所有模块:

1. loadConfig()
2. 初始化 SQLite、SessionManager、ProjectManager
3. 创建 FeishuClient
4. 创建 EventDispatcher，注册事件处理器（event-handlers.ts）
5. 启动 WebSocket
6. SIGINT/SIGTERM → active-registry.abortAll() + 清理
```

## 测试策略

### 保留的测试（不需要改）
- `config.test.ts` — 配置加载
- `session/db.test.ts` — 数据库操作
- `session/manager.test.ts` — 会话管理
- `project/manager.test.ts` — 项目管理
- `utils/command.test.ts` — 命令解析

### 需要重写的测试
- `feishu/cards.test.ts` → `card/builder.test.ts`
- `integration.test.ts` — 适配新管线

### 新增的测试
- `messaging/inbound/dedup.test.ts` — FIFO 上限、过期检查、定时清理
- `messaging/inbound/parse.test.ts` — mention 解析、bot mention 移除
- `messaging/inbound/gate.test.ts` — 白名单、群聊 @bot 检查、/whoami 绕过
- `channel/chat-queue.test.ts` — 串行执行、自清理、跨 chat 并行
- `card/flush-controller.test.ts` — mutex、reflush、长间隔检测

## 不在本次范围

- 飞书文档/多维表格/日历/任务工具（子项目 2）
- OAuth 授权流程（子项目 2）
- 多账号支持（子项目 2）
- 按群独立配置和系统提示词（子项目 2）
- CardKit 2.0 的 `streamCardContent()` API（需要确认 Node SDK 是否支持，本次用 patch 更新）
