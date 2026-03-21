# 工具调用状态实时展示

**Date:** 2026-03-22
**Status:** Draft

## Goal

在 streaming 卡片中实时展示 Claude 的思考过程和工具调用状态，让用户知道 bot 在做什么，而不是只看到一个空白的 "Processing..."。

## 卡片内容结构

CardKit 2.0 streaming 卡片改为三个区域：

```
┌─────────────────────────────────┐
│ 💭 Thinking...                  │  ← thinking_status element
│ 正在分析项目结构...               │
│ ───────────────────────         │
│ ✓ 已完成 8 个工具调用             │  ← tool_status element
│ ✓ Read src/config.ts (89 lines) │
│ ✓ Grep "model" (5 匹配)         │
│ 🔧 Bash: npm test (5s)          │
│ ───────────────────────         │
│ [Claude 的回复在这里...]          │  ← streaming_content element (existing)
└─────────────────────────────────┘
```

### 三个 CardKit element

| element_id | 内容 | 更新频率 |
|-----------|------|---------|
| `thinking_status` | Thinking 指示 + 内容摘要 | thinking 开始/结束时 |
| `tool_status` | 工具调用列表 | 每次工具 start/end/progress |
| `streaming_content` | Claude 回复文字 | streaming（现有） |

### Thinking 区域

- Claude 进入 thinking 时显示：`💭 Thinking...` + 思考内容前 200 字
- Thinking 结束后：清空或显示 `💭 思考完成 (3.2s)`
- 不在 thinking 时：空内容（element 不占空间）

### 工具状态区域

- 最近 5 个工具详细展示
- 更早的折叠为：`✓ 已完成 N 个工具调用`
- 每个工具一行：`状态图标 工具名: 参数摘要 (耗时/结果)`

状态图标：
- `🔧` — 执行中
- `✓` — 完成
- `✗` — 失败/拒绝

工具参数摘要提取规则：
- `Bash` → 显示 command 前 80 字符
- `Read/Write/Edit` → 显示 file_path
- `Glob` → 显示 pattern
- `Grep` → 显示 pattern
- `WebSearch` → 显示 query
- 其他 → 显示工具名

工具结果摘要（简短）：
- `Read` → "N lines"
- `Bash` → 截取输出前 50 字符
- `Grep` → "N matches"
- 其他 → "done"

### 回复文字区域

保持现有 streaming 行为不变。

## Executor 改造

### 新增处理的消息类型

1. **`tool_progress`** — 提取 `tool_name`, `elapsed_time_seconds`, `tool_use_id`
2. **`assistant` → `tool_use` blocks** — 增强参数提取（完整 input 对象）
3. **`user` → `tool_result` blocks** — 提取结果内容摘要

### 改造 ExecutionCallbacks

```typescript
interface ExecutionCallbacks {
  onText: (fullText: string) => void;                    // 现有
  onThinkingUpdate: (isThinking: boolean, content: string, elapsedMs: number) => void; // 新增
  onToolStart: (toolUseId: string, tool: string, detail: string) => void; // 增强：加 toolUseId
  onToolEnd: (toolUseId: string, resultSummary: string) => void; // 增强：用 toolUseId 关联
  onToolProgress: (toolUseId: string, toolName: string, elapsed: number) => void; // 新增
  onComplete: (result: ExecutionResult) => void;          // 现有
  onError: (error: string) => void;                       // 现有
  onPermissionRequest: (...) => Promise<boolean>;          // 现有
}
```

### 工具关联

`tool_use` block 有 `block.id`（toolUseId），`tool_result` block 有 `tool_use_id` 字段。通过 toolUseId 关联 start 和 end：
- `onToolStart(block.id, block.name, detail)` — 从 assistant 消息的 tool_use block
- `onToolEnd(block.tool_use_id, resultSummary)` — 从 user 消息的 tool_result block
- dispatch 维护 `Map<toolUseId, ToolCallInfo>` 来关联

### Thinking 检测

executor 已经检测 `<thinking>` 标签并在 `onText` 中发送处理后的文字。但 thinking 状态信息（是否在思考、内容、时长）在 executor 内部管理，dispatch 看不到。

改造 executor：新增 `onThinkingUpdate` 回调，在 thinking 状态变化时调用：
- 进入 thinking：`onThinkingUpdate(true, thinkContent, 0)`
- thinking 中（文本更新）：`onThinkingUpdate(true, thinkContent, elapsedMs)`
- thinking 结束：`onThinkingUpdate(false, '', totalElapsedMs)`

dispatch 收到后更新 `thinking_status` element。`onText` 仍然只传递 stripped 的最终文字（不含 thinking 标签）。

## Streaming Card 改造

### 初始 card 结构

```typescript
function buildStreamingThinkingCard(): object {
  return {
    schema: '2.0',
    config: { streaming_mode: true, summary: { content: 'Thinking...' } },
    body: {
      elements: [
        { tag: 'markdown', content: '', text_align: 'left', element_id: 'thinking_status' },
        { tag: 'markdown', content: '', text_align: 'left', element_id: 'tool_status' },
        { tag: 'markdown', content: '', text_align: 'left', element_id: STREAMING_ELEMENT_ID },
      ],
    },
  };
}
```

### 新增方法

```typescript
// 更新 thinking 状态
updateThinking(content: string): void

// 更新工具状态列表
updateToolStatus(statusText: string): void
```

两个方法都通过 `streamCardContent` 更新对应的 element_id。

## 工具状态管理

在 dispatch 的 `handleClaudeTask` 中维护：

```typescript
interface ToolCallInfo {
  toolUseId?: string;
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  resultSummary?: string;
}

const toolCalls: ToolCallInfo[] = [];
const MAX_VISIBLE_TOOLS = 5;
```

每次工具状态变化时，重新渲染工具状态文本：

```typescript
function renderToolStatus(tools: ToolCallInfo[]): string {
  const lines: string[] = [];
  const hiddenCount = Math.max(0, tools.length - MAX_VISIBLE_TOOLS);
  const visible = tools.slice(-MAX_VISIBLE_TOOLS);

  if (hiddenCount > 0) {
    lines.push(`✓ 已完成 ${hiddenCount} 个工具调用`);
  }
  for (const t of visible) {
    const icon = t.status === 'running' ? '🔧' : t.status === 'done' ? '✓' : '✗';
    const elapsed = t.elapsed ? ` (${Math.round(t.elapsed)}s)` : '';
    const result = t.resultSummary ? ` → ${t.resultSummary}` : '';
    lines.push(`${icon} ${t.name}: ${t.detail}${elapsed}${result}`);
  }
  return lines.join('\n');
}
```

## 变更模块

| 模块 | 变更 |
|------|------|
| `src/claude/executor.ts` | 处理 `tool_progress` 消息；增强 tool_use/tool_result 数据提取；新增 `onToolProgress` 回调 |
| `src/card/streaming-card.ts` | 初始 card 加 thinking_status + tool_status elements；新增 updateThinking/updateToolStatus 方法 |
| `src/messaging/inbound/dispatch.ts` | 维护 ToolCallInfo 列表；onText 中更新 thinking 状态；onToolStart/End/Progress 中更新工具状态 |

## Constraints

- CardKit 2.0 `streamCardContent` 可以按 element_id 单独更新每个 element
- 工具状态更新频率不应太高（tool_progress 可能每秒多次），节流到 1 秒一次
- 空 element（content=""）在 CardKit 2.0 中不占空间
- IM fallback 卡片路径也需要支持（降级为简单文本）
- 三个 element 共享同一个 `cardKitSequence` 计数器（per card entity，不是 per element）
- `tool_progress` 消息类型在 TypeScript 中可能需要 `as any` cast（SDK 类型可能不包含）
