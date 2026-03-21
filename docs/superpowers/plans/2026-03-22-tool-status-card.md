# Tool Status Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real-time thinking status and tool execution details in the streaming card during Claude task execution.

**Architecture:** The CardKit 2.0 streaming card gets two new elements (`thinking_status` and `tool_status`) alongside the existing `streaming_content`. Executor is enhanced with `onThinkingUpdate` and `onToolProgress` callbacks, plus richer `onToolStart/End` with toolUseId for correlation. Dispatch maintains a `ToolCallInfo[]` list and renders it into the `tool_status` element via StreamingCard's new `updateToolStatus()` method.

**Tech Stack:** Existing CardKit 2.0 `streamCardContent` API (supports per-element-id updates), `@anthropic-ai/claude-agent-sdk` message types

---

## File Structure

| File | Change |
|------|--------|
| Modify: `src/claude/executor.ts` | Add onThinkingUpdate/onToolProgress callbacks; enhance onToolStart/End with toolUseId; handle tool_progress message type |
| Modify: `src/card/streaming-card.ts` | Add thinking_status + tool_status elements; new updateThinking/updateToolStatus methods |
| Modify: `src/messaging/inbound/dispatch.ts` | Maintain ToolCallInfo list; wire new callbacks to card updates |

---

### Task 1: Enhance executor with richer callbacks

**Files:**
- Modify: `src/claude/executor.ts`

- [ ] **Step 1: Update ExecutionCallbacks interface**

Change the interface (currently at lines 38-45):

```typescript
export interface ExecutionCallbacks {
  onText: (fullText: string) => void;
  onThinkingUpdate: (isThinking: boolean, content: string, elapsedMs: number) => void;
  onToolStart: (toolUseId: string, tool: string, detail: string) => void;
  onToolEnd: (toolUseId: string, resultSummary: string) => void;
  onToolProgress: (toolUseId: string, toolName: string, elapsed: number) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: string) => void;
  onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}
```

- [ ] **Step 2: Update stream_event case to call onThinkingUpdate**

In the `stream_event` case (lines 130-158), after the thinking detection logic, call `onThinkingUpdate`:

```typescript
// After the existing wasInReasoning/isInReasoning logic:
if (isInReasoning) {
  const thinkContent = extractThinkingContent(fullText);
  callbacks.onThinkingUpdate(true, thinkContent, reasoningStartTime ? Date.now() - reasoningStartTime : 0);
  callbacks.onText(`💭 **Thinking...**\n\n${thinkContent}`);
} else {
  if (wasInReasoning) {
    // Just exited thinking
    callbacks.onThinkingUpdate(false, '', reasoningElapsedMs);
  }
  callbacks.onText(stripThinkingTags(fullText));
}
```

Replace the existing if/else for onText (lines 148-153) with this version.

- [ ] **Step 3: Update assistant case to pass toolUseId**

In the `assistant` case (lines 160-174), change onToolStart call:

```typescript
// Current: callbacks.onToolStart(block.name, String(detail));
// New:
callbacks.onToolStart(block.id, block.name, String(detail));
```

`block.id` is the toolUseId from the SDK's tool_use content block.

- [ ] **Step 4: Update user case to pass toolUseId and result summary**

In the `user` case (lines 176-190), enhance tool_result extraction:

```typescript
case 'user': {
  const content = message.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as any).type === 'tool_result') {
        const toolUseId = (block as any).tool_use_id || '';
        // Extract result summary from content
        const resultContent = (block as any).content;
        let summary = 'done';
        if (typeof resultContent === 'string') {
          summary = resultContent.slice(0, 80);
        } else if (Array.isArray(resultContent)) {
          const textBlock = resultContent.find((b: any) => b.type === 'text');
          if (textBlock?.text) summary = textBlock.text.slice(0, 80);
        }
        callbacks.onToolEnd(toolUseId, summary);
      }
    }
  }
  break;
}
```

- [ ] **Step 5: Add tool_progress message handler**

Add a new case in the switch, after the `user` case:

```typescript
case 'tool_progress' as any: {
  const msg = message as any;
  if (msg.tool_use_id && msg.tool_name) {
    callbacks.onToolProgress(msg.tool_use_id, msg.tool_name, msg.elapsed_time_seconds ?? 0);
  }
  break;
}
```

- [ ] **Step 6: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: enhance executor with thinking/tool progress callbacks"`

---

### Task 2: Add thinking and tool status elements to StreamingCard

**Files:**
- Modify: `src/card/streaming-card.ts`

- [ ] **Step 1: Add element ID constants**

Add alongside existing `STREAMING_ELEMENT_ID`:

```typescript
const THINKING_ELEMENT_ID = 'thinking_status';
const TOOL_STATUS_ELEMENT_ID = 'tool_status';
```

- [ ] **Step 2: Update buildStreamingThinkingCard**

Add the two new elements before `streaming_content`:

```typescript
function buildStreamingThinkingCard(_mentionTarget?: MentionTarget | null): object {
  const elements: any[] = [];
  elements.push({ tag: 'markdown', content: '', text_align: 'left', element_id: THINKING_ELEMENT_ID });
  elements.push({ tag: 'markdown', content: '', text_align: 'left', element_id: TOOL_STATUS_ELEMENT_ID });
  elements.push({ tag: 'markdown', content: '', text_align: 'left', element_id: STREAMING_ELEMENT_ID });
  return {
    schema: '2.0',
    config: { streaming_mode: true, summary: { content: 'Working...' } },
    body: { elements },
  };
}
```

Empty content elements don't take space in CardKit 2.0.

- [ ] **Step 3: Add updateThinking method**

```typescript
async updateThinking(content: string): Promise<void> {
  if (!this.cardKitCardId || this.isTerminal) return;
  this.cardKitSequence++;
  await streamCardContent(this.cardKitCardId, THINKING_ELEMENT_ID, content, this.cardKitSequence);
}
```

- [ ] **Step 4: Add updateToolStatus method**

```typescript
async updateToolStatus(content: string): Promise<void> {
  if (!this.cardKitCardId || this.isTerminal) return;
  this.cardKitSequence++;
  await streamCardContent(this.cardKitCardId, TOOL_STATUS_ELEMENT_ID, content, this.cardKitSequence);
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npx tsc --noEmit && npx vitest run`
Commit: `git commit -m "feat: streaming card with thinking and tool status elements"`

---

### Task 3: Wire callbacks in dispatch to update card

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Define ToolCallInfo and renderToolStatus**

Add at module level:

```typescript
interface ToolCallInfo {
  toolUseId: string;
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  resultSummary?: string;
}

const MAX_VISIBLE_TOOLS = 5;

function renderToolStatus(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines: string[] = [];
  const hiddenCount = Math.max(0, tools.length - MAX_VISIBLE_TOOLS);
  const visible = tools.slice(-MAX_VISIBLE_TOOLS);
  if (hiddenCount > 0) {
    lines.push(`✓ 已完成 ${hiddenCount} 个工具调用`);
  }
  for (const t of visible) {
    const icon = t.status === 'running' ? '🔧' : t.status === 'done' ? '✓' : '✗';
    const elapsed = t.elapsed ? ` (${Math.round(t.elapsed)}s)` : '';
    const result = t.resultSummary && t.status === 'done' ? ` → ${t.resultSummary}` : '';
    lines.push(`${icon} ${t.name}: ${t.detail}${elapsed}${result}`);
  }
  return lines.join('\n');
}

function extractToolDetail(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return String(input.command || tool).slice(0, 80);
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') return String(input.file_path || tool);
  if (tool === 'Glob') return String(input.pattern || tool);
  if (tool === 'Grep') return String(input.pattern || tool);
  if (tool === 'WebSearch') return String(input.query || tool);
  return tool;
}
```

- [ ] **Step 2: Replace tools array and update callbacks**

In `handleClaudeTask`, replace the existing `const tools: ToolStatus[] = [];` with:

```typescript
const toolCalls: ToolCallInfo[] = [];
const toolUseIdMap = new Map<string, number>(); // toolUseId → index in toolCalls
```

Replace the callbacks object:

```typescript
{
  onText: (fullText) => { void card.scheduleStreamText(fullText); },
  onThinkingUpdate: (isThinking, content, elapsedMs) => {
    if (isThinking) {
      const truncated = content.length > 200 ? content.slice(0, 200) + '...' : content;
      void card.updateThinking(`💭 **Thinking...**\n${truncated}`);
    } else {
      const elapsed = elapsedMs > 0 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : '';
      void card.updateThinking(elapsedMs > 0 ? `💭 思考完成${elapsed}` : '');
    }
  },
  onToolStart: (toolUseId, tool, detail) => {
    const idx = toolCalls.length;
    toolCalls.push({ toolUseId, name: tool, detail, status: 'running' });
    toolUseIdMap.set(toolUseId, idx);
    void card.updateToolStatus(renderToolStatus(toolCalls));
  },
  onToolEnd: (toolUseId, resultSummary) => {
    const idx = toolUseIdMap.get(toolUseId);
    if (idx !== undefined && toolCalls[idx]) {
      toolCalls[idx].status = 'done';
      toolCalls[idx].resultSummary = resultSummary;
    } else {
      // Fallback: mark first running tool as done
      const running = toolCalls.find(t => t.status === 'running');
      if (running) { running.status = 'done'; running.resultSummary = resultSummary; }
    }
    void card.updateToolStatus(renderToolStatus(toolCalls));
  },
  onToolProgress: (toolUseId, _toolName, elapsed) => {
    const idx = toolUseIdMap.get(toolUseId);
    if (idx !== undefined && toolCalls[idx]) {
      toolCalls[idx].elapsed = elapsed;
      void card.updateToolStatus(renderToolStatus(toolCalls));
    }
  },
  onPermissionRequest: async (toolName, input) => {
    // existing permission logic unchanged
  },
  onComplete: async (result: ExecutionResult) => {
    // existing onComplete logic — use toolCalls.length for count
  },
  onError: async (error) => {
    // existing onError logic unchanged
  },
}
```

- [ ] **Step 3: Update onComplete to use toolCalls instead of tools**

Replace references to `tools.map(t => t.tool)` with `toolCalls.map(t => t.name)` in the `onComplete` callback. Replace `result.toolCount` usage in `CardBuilder.done()` with `toolCalls.length` if needed (result.toolCount from executor should already be correct).

- [ ] **Step 4: Update onPermissionRequest to use extractToolDetail**

In the permission request callback, enhance the detail extraction:

```typescript
onPermissionRequest: async (toolName, input) => {
  const detail = extractToolDetail(toolName, input);
  // ... rest of existing permission logic, using `detail` for the confirm card
}
```

- [ ] **Step 5: Run all tests**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: real-time tool status and thinking in streaming card"
```

---

### Task 4: Manual testing

- [ ] **Step 1: Test thinking display**

1. Start bot, send a complex question
2. Verify: card shows "💭 Thinking..." with content during thinking
3. After thinking: shows "💭 思考完成 (Xs)"

- [ ] **Step 2: Test tool status**

1. Ask Claude to do something that requires tools (e.g., "read src/index.ts and summarize")
2. Verify: card shows "🔧 Read: src/index.ts" while running
3. After complete: shows "✓ Read: src/index.ts → done"

- [ ] **Step 3: Test multiple tools**

1. Ask Claude to do multiple things (e.g., "search for TODO in the codebase and list all files")
2. Verify: multiple tool lines appear, scroll as more are added
3. After 5+: oldest collapse to "✓ 已完成 N 个工具调用"

- [ ] **Step 4: Test tool progress (Bash)**

1. Ask Claude to run a slow command (e.g., `npm test`)
2. Verify: elapsed time updates while running ("🔧 Bash: npm test (3s)")
