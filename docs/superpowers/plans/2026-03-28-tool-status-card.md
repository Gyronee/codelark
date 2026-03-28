# Tool Status Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign tool status rendering from flat list to tree-structured view with batch grouping, agent nesting, and smart collapse.

**Architecture:** Introduce a `ToolRenderState` class in a new `src/card/tool-render-state.ts` that tracks tool calls, agent hierarchy, and batch grouping. The existing `renderToolStatus()` in dispatch.ts delegates to this class. The executor gains handlers for `system` messages (`task_started`, `task_notification`) and passes `parent_tool_use_id` to callbacks.

**Tech Stack:** TypeScript, Vitest, CardKit 2.0 markdown rendering

---

### Task 1: Add ToolRenderState data model and renderer

**Files:**
- Create: `src/card/tool-render-state.ts`
- Create: `src/card/tool-render-state.test.ts`

- [ ] **Step 1: Write failing tests for ToolRenderState**

```typescript
// src/card/tool-render-state.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRenderState } from './tool-render-state.js';

describe('ToolRenderState', () => {
  describe('basic tool tracking', () => {
    it('renders a single running tool', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts', parentToolUseId: null });
      expect(state.render()).toBe('⏳ Read: src/index.ts');
    });

    it('renders done tool with elapsed', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts', parentToolUseId: null });
      state.completeTool('t1', 'done', 1.2);
      expect(state.render()).toBe('✓ Read: src/index.ts (1.2s)');
    });

    it('renders error tool', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Bash', detail: 'npm test', parentToolUseId: null });
      state.completeTool('t1', 'error', 3.0);
      expect(state.render()).toBe('✗ Bash: npm test (3.0s)');
    });
  });

  describe('batch grouping', () => {
    it('groups consecutive same-tool calls', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts', parentToolUseId: null });
      state.completeTool('t1', 'done', 0.8);
      state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/config.ts', parentToolUseId: null });
      state.completeTool('t2', 'done', 1.0);
      const lines = state.render().split('\n');
      expect(lines[0]).toBe('✓ Read 2 files (1.8s)');
      expect(lines[1]).toBe('  src/index.ts, src/config.ts');
    });

    it('does not group non-consecutive same-tool calls', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: null });
      state.completeTool('t1', 'done', 0.5);
      state.addTool({ toolUseId: 't2', name: 'Edit', detail: 'src/b.ts', parentToolUseId: null });
      state.completeTool('t2', 'done', 1.0);
      state.addTool({ toolUseId: 't3', name: 'Read', detail: 'src/c.ts', parentToolUseId: null });
      state.completeTool('t3', 'done', 0.5);
      const lines = state.render().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('Read: src/a.ts');
      expect(lines[1]).toContain('Edit: src/b.ts');
      expect(lines[2]).toContain('Read: src/c.ts');
    });

    it('keeps running tool unbatched at end', () => {
      const state = new ToolRenderState();
      state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: null });
      state.completeTool('t1', 'done', 0.5);
      state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/b.ts', parentToolUseId: null });
      // t2 still running
      const lines = state.render().split('\n');
      expect(lines[0]).toContain('Read: src/a.ts');
      expect(lines[1]).toBe('⏳ Read: src/b.ts');
    });
  });

  describe('truncation', () => {
    it('truncates main tools beyond 5 visible', () => {
      const state = new ToolRenderState();
      for (let i = 1; i <= 7; i++) {
        state.addTool({ toolUseId: `t${i}`, name: 'Bash', detail: `cmd${i}`, parentToolUseId: null });
        state.completeTool(`t${i}`, 'done', 1.0);
      }
      const lines = state.render().split('\n');
      expect(lines[0]).toBe('✓ 已完成 2 次工具调用');
      expect(lines).toHaveLength(6); // 1 summary + 5 visible
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/card/tool-render-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ToolRenderState**

```typescript
// src/card/tool-render-state.ts

interface ToolEntry {
  toolUseId: string;
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  parentToolUseId: string | null;
}

interface AgentEntry {
  toolUseId: string;   // The Agent tool_use_id (= parentToolUseId of child tools)
  name: string;        // Agent description/type
  status: 'running' | 'done';
  tools: ToolEntry[];
  totalElapsed: number;
}

interface AddToolInput {
  toolUseId: string;
  name: string;
  detail: string;
  parentToolUseId: string | null;
}

const MAX_VISIBLE = 5;

export class ToolRenderState {
  private mainTools: ToolEntry[] = [];
  private agents = new Map<string, AgentEntry>();
  private toolIndex = new Map<string, ToolEntry>();
  // Track insertion order for main-level items (tools + agents interleaved)
  private mainOrder: Array<{ type: 'tool'; id: string } | { type: 'agent'; id: string }> = [];

  addAgent(toolUseId: string, name: string): void {
    const agent: AgentEntry = { toolUseId, name, status: 'running', tools: [], totalElapsed: 0 };
    this.agents.set(toolUseId, agent);
    this.mainOrder.push({ type: 'agent', id: toolUseId });
  }

  completeAgent(toolUseId: string): void {
    const agent = this.agents.get(toolUseId);
    if (agent) {
      agent.status = 'done';
      agent.totalElapsed = agent.tools.reduce((sum, t) => sum + (t.elapsed ?? 0), 0);
    }
  }

  addTool(input: AddToolInput): void {
    const entry: ToolEntry = {
      toolUseId: input.toolUseId,
      name: input.name,
      detail: input.detail,
      status: 'running',
      parentToolUseId: input.parentToolUseId,
    };
    this.toolIndex.set(input.toolUseId, entry);

    if (input.parentToolUseId && this.agents.has(input.parentToolUseId)) {
      this.agents.get(input.parentToolUseId)!.tools.push(entry);
    } else {
      this.mainTools.push(entry);
      this.mainOrder.push({ type: 'tool', id: input.toolUseId });
    }
  }

  completeTool(toolUseId: string, status: 'done' | 'error', elapsed?: number): void {
    const entry = this.toolIndex.get(toolUseId);
    if (entry) {
      entry.status = status;
      entry.elapsed = elapsed;
    }
  }

  updateToolElapsed(toolUseId: string, elapsed: number): void {
    const entry = this.toolIndex.get(toolUseId);
    if (entry) entry.elapsed = elapsed;
  }

  render(): string {
    // Build main-level render items in insertion order
    const items = this.buildMainItems();
    return this.applyTruncation(items).join('\n');
  }

  private buildMainItems(): string[] {
    const lines: string[] = [];
    // Process mainOrder to build lines, grouping consecutive same-tool entries
    let i = 0;
    const orderItems = this.mainOrder;

    while (i < orderItems.length) {
      const item = orderItems[i];

      if (item.type === 'agent') {
        const agent = this.agents.get(item.id);
        if (agent) {
          if (agent.status === 'done') {
            lines.push(`✓ Agent: ${agent.name} (${agent.tools.length} tools, ${agent.totalElapsed.toFixed(1)}s)`);
          } else {
            lines.push(`▶ Agent: ${agent.name}`);
            const agentToolLines = this.renderToolList(agent.tools, '  ');
            lines.push(...agentToolLines);
          }
        }
        i++;
        continue;
      }

      // Tool entry — check for batch grouping
      const tool = this.mainTools.find(t => t.toolUseId === item.id);
      if (!tool) { i++; continue; }

      // Only batch consecutive completed tools with same name
      if (tool.status !== 'running') {
        const batch = [tool];
        let j = i + 1;
        while (j < orderItems.length) {
          const next = orderItems[j];
          if (next.type !== 'tool') break;
          const nextTool = this.mainTools.find(t => t.toolUseId === next.id);
          if (!nextTool || nextTool.name !== tool.name || nextTool.status === 'running') break;
          batch.push(nextTool);
          j++;
        }
        if (batch.length > 1) {
          lines.push(...this.renderBatch(batch, ''));
          i = j;
          continue;
        }
      }

      lines.push(this.renderSingleTool(tool, ''));
      i++;
    }

    return lines;
  }

  private renderToolList(tools: ToolEntry[], indent: string): string[] {
    const lines: string[] = [];
    let i = 0;
    while (i < tools.length) {
      const tool = tools[i];
      if (tool.status !== 'running') {
        const batch = [tool];
        let j = i + 1;
        while (j < tools.length) {
          const next = tools[j];
          if (next.name !== tool.name || next.status === 'running') break;
          batch.push(next);
          j++;
        }
        if (batch.length > 1) {
          lines.push(...this.renderBatch(batch, indent));
          i = j;
          continue;
        }
      }
      lines.push(this.renderSingleTool(tool, indent));
      i++;
    }
    return lines;
  }

  private renderBatch(batch: ToolEntry[], indent: string): string[] {
    const totalElapsed = batch.reduce((sum, t) => sum + (t.elapsed ?? 0), 0);
    const icon = batch.every(t => t.status === 'done') ? '✓' : '✗';
    const details = batch.map(t => t.detail);
    const noun = batch[0].name === 'Bash' ? 'commands' : 'files';
    const lines = [
      `${indent}${icon} ${batch[0].name} ${batch.length} ${noun} (${totalElapsed.toFixed(1)}s)`,
      `${indent}  ${details.join(', ')}`,
    ];
    return lines;
  }

  private renderSingleTool(tool: ToolEntry, indent: string): string {
    const icon = tool.status === 'running' ? '⏳' : tool.status === 'done' ? '✓' : '✗';
    if (tool.status === 'running') {
      const elapsed = tool.elapsed ? ` (${Math.round(tool.elapsed)}s...)` : '';
      return `${indent}${icon} ${tool.name}: ${tool.detail}${elapsed}`;
    }
    const elapsed = tool.elapsed ? ` (${tool.elapsed.toFixed(1)}s)` : '';
    return `${indent}${icon} ${tool.name}: ${tool.detail}${elapsed}`;
  }

  private applyTruncation(lines: string[]): string[] {
    // Count main-level items (non-indented lines)
    const mainLines = lines.filter(l => !l.startsWith('  '));
    if (mainLines.length <= MAX_VISIBLE) return lines;

    // Keep last MAX_VISIBLE main items + their sub-lines
    const result: string[] = [];
    const hiddenCount = mainLines.length - MAX_VISIBLE;
    result.push(`✓ 已完成 ${hiddenCount} 次工具调用`);

    let mainSeen = 0;
    for (const line of lines) {
      if (!line.startsWith('  ')) {
        mainSeen++;
        if (mainSeen > hiddenCount) result.push(line);
      } else if (mainSeen > hiddenCount) {
        result.push(line);
      }
    }
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/card/tool-render-state.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/card/tool-render-state.ts src/card/tool-render-state.test.ts
git commit -m "feat: add ToolRenderState with batch grouping and truncation"
```

---

### Task 2: Add agent nesting tests and implementation

**Files:**
- Modify: `src/card/tool-render-state.test.ts`
- Modify: `src/card/tool-render-state.ts` (if needed)

- [ ] **Step 1: Write failing tests for agent nesting**

Append to `src/card/tool-render-state.test.ts`:

```typescript
describe('agent nesting', () => {
  it('renders running agent with indented tools', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: null });
    state.completeTool('t1', 'done', 0.5);
    // Agent tool_use creates the agent
    state.addAgent('agent1', 'code-reviewer');
    // Tools inside the agent
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/b.ts', parentToolUseId: 'agent1' });
    state.completeTool('t2', 'done', 0.8);
    state.addTool({ toolUseId: 't3', name: 'Grep', detail: 'renderToolStatus', parentToolUseId: 'agent1' });

    const lines = state.render().split('\n');
    expect(lines[0]).toBe('✓ Read: src/a.ts (0.5s)');
    expect(lines[1]).toBe('▶ Agent: code-reviewer');
    expect(lines[2]).toBe('  ✓ Read: src/b.ts (0.8s)');
    expect(lines[3]).toBe('  ⏳ Grep: renderToolStatus');
  });

  it('collapses completed agent to summary', () => {
    const state = new ToolRenderState();
    state.addAgent('agent1', 'code-reviewer');
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: 'agent1' });
    state.completeTool('t1', 'done', 0.8);
    state.addTool({ toolUseId: 't2', name: 'Edit', detail: 'src/b.ts', parentToolUseId: 'agent1' });
    state.completeTool('t2', 'done', 1.5);
    state.completeAgent('agent1');

    const rendered = state.render();
    expect(rendered).toBe('✓ Agent: code-reviewer (2 tools, 2.3s)');
  });

  it('groups consecutive reads inside agent', () => {
    const state = new ToolRenderState();
    state.addAgent('agent1', 'explorer');
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'a.ts', parentToolUseId: 'agent1' });
    state.completeTool('t1', 'done', 0.3);
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'b.ts', parentToolUseId: 'agent1' });
    state.completeTool('t2', 'done', 0.4);
    state.addTool({ toolUseId: 't3', name: 'Bash', detail: 'npm test', parentToolUseId: 'agent1' });

    const lines = state.render().split('\n');
    expect(lines[0]).toBe('▶ Agent: explorer');
    expect(lines[1]).toBe('  ✓ Read 2 files (0.7s)');
    expect(lines[2]).toBe('    a.ts, b.ts');
    expect(lines[3]).toBe('  ⏳ Bash: npm test');
  });

  it('flattens deeply nested agents to 2 levels', () => {
    const state = new ToolRenderState();
    state.addAgent('agent1', 'orchestrator');
    // Nested agent inside agent1 — should be treated as agent1's tool
    state.addTool({ toolUseId: 'nested-agent', name: 'Agent', detail: 'sub-task', parentToolUseId: 'agent1' });
    // Tools with parent = nested-agent should flatten to agent1 level
    // (We don't call addAgent for nested-agent since depth > 2)
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'deep.ts', parentToolUseId: 'agent1' });
    state.completeTool('t1', 'done', 0.5);

    const lines = state.render().split('\n');
    expect(lines[0]).toBe('▶ Agent: orchestrator');
    // nested-agent shown as a regular tool, deep.ts also at agent1 level
    expect(lines[1]).toBe('  ⏳ Agent: sub-task');
    expect(lines[2]).toBe('  ✓ Read: deep.ts (0.5s)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/card/tool-render-state.test.ts`
Expected: agent nesting tests FAIL

- [ ] **Step 3: Fix implementation to pass agent nesting tests**

The `renderBatch` indent for sub-lines inside agents needs double-indent (`    ` = 4 spaces). Update the `renderBatch` method to use `${indent}  ` for the detail line (relative to the parent indent):

In `renderBatch`, change the detail line to:
```typescript
`${indent}  ${details.join(', ')}`,
```

This already uses `indent` + 2 spaces. When called from `renderToolList` with `indent='  '`, the detail line becomes `    a.ts, b.ts` (4 spaces). This is correct.

Verify the `renderToolList` passes the correct indent. The agent rendering in `buildMainItems` calls `this.renderToolList(agent.tools, '  ')` — this means agent sub-tools get `  ` prefix, and their batch detail lines get `    ` prefix. This matches the test expectations.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/card/tool-render-state.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/card/tool-render-state.ts src/card/tool-render-state.test.ts
git commit -m "feat: add agent nesting with collapse and batch grouping"
```

---

### Task 3: Wire executor to emit agent and parent_tool_use_id events

**Files:**
- Modify: `src/claude/executor.ts`

- [ ] **Step 1: Add onAgentStart and onAgentEnd to ExecutionCallbacks**

In `src/claude/executor.ts`, update the `ExecutionCallbacks` interface:

```typescript
export interface ExecutionCallbacks {
  onText: (fullText: string) => void;
  onThinkingUpdate: (isThinking: boolean, content: string, elapsedMs: number) => void;
  onToolStart: (toolUseId: string, tool: string, detail: string, parentToolUseId: string | null) => void;
  onToolEnd: (toolUseId: string, resultSummary: string) => void;
  onToolProgress: (toolUseId: string, toolName: string, elapsed: number) => void;
  onAgentStart: (toolUseId: string, name: string) => void;
  onAgentEnd: (toolUseId: string, summary: string, toolCount: number, durationMs: number) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: string) => void;
  onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}
```

- [ ] **Step 2: Update the assistant message handler to pass parentToolUseId and detect Agent tool**

In the `case 'assistant'` block, update tool_use handling:

```typescript
case 'assistant': {
  const content = message.message?.content;
  const parentId = (message as any).parent_tool_use_id ?? null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCount++;
        const input = block.input as Record<string, unknown> | undefined;
        if (block.name === 'Agent') {
          // Agent tool invocation — register as agent
          const agentDesc = (input?.description ?? input?.prompt ?? 'sub-agent') as string;
          callbacks.onAgentStart(block.id, agentDesc.slice(0, 60));
        }
        const detail =
          (input?.command ?? input?.file_path ?? input?.pattern ?? block.name) as string;
        callbacks.onToolStart(block.id, block.name, String(detail), parentId);
      }
    }
  }
  break;
}
```

- [ ] **Step 3: Add system message handler for task_started and task_notification**

Add a new case in the switch statement, before the `default` case:

```typescript
case 'system' as any: {
  const msg = message as any;
  if (msg.subtype === 'task_notification' && msg.tool_use_id) {
    const status = msg.status as string;
    const summary = msg.summary || '';
    const toolUses = msg.usage?.tool_uses ?? 0;
    const durationMs = msg.usage?.duration_ms ?? 0;
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
      callbacks.onAgentEnd(msg.tool_use_id, summary, toolUses, durationMs);
    }
  }
  break;
}
```

- [ ] **Step 4: Update tool_progress handler to pass parent_tool_use_id**

The `tool_progress` case already has the data; no change needed for progress since `updateToolElapsed` uses `toolUseId` directly.

- [ ] **Step 5: Run full test suite to verify nothing breaks**

Run: `npx vitest run`
Expected: ALL PASS (existing tests should not break since `onToolStart` is called from dispatch.ts which we haven't changed yet)

- [ ] **Step 6: Commit**

```bash
git add src/claude/executor.ts
git commit -m "feat: executor emits agent start/end and parentToolUseId in callbacks"
```

---

### Task 4: Wire dispatch.ts to use ToolRenderState

**Files:**
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Replace ToolCallInfo and renderToolStatus with ToolRenderState**

In `src/messaging/inbound/dispatch.ts`:

1. Add import at top:
```typescript
import { ToolRenderState } from '../../card/tool-render-state.js';
```

2. Remove the `ToolCallInfo` interface (lines ~718-725) and `renderToolStatus` function (lines ~729-744).

3. In `handleClaudeTask`, replace:
```typescript
const toolCalls: ToolCallInfo[] = [];
const toolUseIdMap = new Map<string, number>();
```
with:
```typescript
const toolState = new ToolRenderState();
```

4. Update the `onToolStart` callback:
```typescript
onToolStart: (toolUseId, tool, detail, parentToolUseId) => {
  toolState.addTool({ toolUseId, name: tool, detail, parentToolUseId });
  void card.updateToolStatus(toolState.render());
},
```

5. Update the `onToolEnd` callback:
```typescript
onToolEnd: (toolUseId, _resultSummary) => {
  toolState.completeTool(toolUseId, 'done');
  void card.updateToolStatus(toolState.render());
},
```

6. Update the `onToolProgress` callback:
```typescript
onToolProgress: (toolUseId, _toolName, elapsed) => {
  toolState.updateToolElapsed(toolUseId, elapsed);
  void card.updateToolStatus(toolState.render());
},
```

7. Add the agent callbacks:
```typescript
onAgentStart: (toolUseId, name) => {
  toolState.addAgent(toolUseId, name);
  void card.updateToolStatus(toolState.render());
},
onAgentEnd: (toolUseId, _summary, _toolCount, _durationMs) => {
  toolState.completeAgent(toolUseId);
  void card.updateToolStatus(toolState.render());
},
```

8. Update the `db.logTask` call — currently it logs `JSON.stringify(toolCalls.map(t => t.name))`. Replace with a simple count since we no longer have `toolCalls` array:
```typescript
db.logTask(session.id, ctx.text, result.text, `${result.toolCount} tools`, result.durationMs, 'success');
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/messaging/inbound/dispatch.ts
git commit -m "feat: wire ToolRenderState into dispatch for tree-structured tool status"
```

---

### Task 5: Integration test with realistic tool sequence

**Files:**
- Modify: `src/card/tool-render-state.test.ts`

- [ ] **Step 1: Write integration-style test simulating a real session**

Append to `src/card/tool-render-state.test.ts`:

```typescript
describe('realistic session simulation', () => {
  it('renders full session with agent and batch grouping', () => {
    const state = new ToolRenderState();

    // Main task reads files
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts', parentToolUseId: null });
    state.completeTool('t1', 'done', 0.8);
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/config.ts', parentToolUseId: null });
    state.completeTool('t2', 'done', 1.0);

    // Main task edits
    state.addTool({ toolUseId: 't3', name: 'Edit', detail: 'src/config.ts', parentToolUseId: null });
    state.completeTool('t3', 'done', 1.5);

    // Agent spawned
    state.addAgent('agent1', 'code-reviewer');
    state.addTool({ toolUseId: 'a1t1', name: 'Read', detail: 'src/card/builder.ts', parentToolUseId: 'agent1' });
    state.completeTool('a1t1', 'done', 0.6);
    state.addTool({ toolUseId: 'a1t2', name: 'Read', detail: 'src/card/streaming-card.ts', parentToolUseId: 'agent1' });
    state.completeTool('a1t2', 'done', 0.7);
    state.addTool({ toolUseId: 'a1t3', name: 'Read', detail: 'src/claude/executor.ts', parentToolUseId: 'agent1' });
    state.completeTool('a1t3', 'done', 0.5);

    // Agent still running — should show expanded
    let lines = state.render().split('\n');
    expect(lines[0]).toBe('✓ Read 2 files (1.8s)');
    expect(lines[1]).toBe('  src/index.ts, src/config.ts');
    expect(lines[2]).toBe('✓ Edit: src/config.ts (1.5s)');
    expect(lines[3]).toBe('▶ Agent: code-reviewer');
    expect(lines[4]).toBe('  ✓ Read 3 files (1.8s)');
    expect(lines[5]).toBe('    src/card/builder.ts, src/card/streaming-card.ts, src/claude/executor.ts');

    // Agent completes
    state.completeAgent('agent1');

    // Main task continues
    state.addTool({ toolUseId: 't4', name: 'Bash', detail: 'npx tsc --noEmit', parentToolUseId: null });

    lines = state.render().split('\n');
    expect(lines[0]).toBe('✓ Read 2 files (1.8s)');
    expect(lines[1]).toBe('  src/index.ts, src/config.ts');
    expect(lines[2]).toBe('✓ Edit: src/config.ts (1.5s)');
    expect(lines[3]).toBe('✓ Agent: code-reviewer (3 tools, 1.8s)');
    expect(lines[4]).toBe('⏳ Bash: npx tsc --noEmit');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/card/tool-render-state.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/card/tool-render-state.test.ts
git commit -m "test: add integration test for realistic tool status session"
```

---

### Task 6: Manual smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Send a test message via Feishu that triggers tool usage**

Send a message to the bot that will cause multiple tool calls (e.g., "看一下 src/index.ts 和 src/config.ts 的内容，然后运行 npm test").

- [ ] **Step 3: Verify card displays**

Check in Feishu that:
- Batch grouping shows "✓ Read 2 files" with file list below
- Running tools show `⏳` icon
- Completed tools show `✓` icon
- If an agent is spawned, it shows `▶ Agent: ...` with indented tools

- [ ] **Step 4: Commit any fixes if needed**

```bash
git add -u
git commit -m "fix: adjust tool status rendering from smoke test feedback"
```
