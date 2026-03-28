# Tool/Agent Status Card Redesign

## Goal

Improve the tool status display in streaming cards from a flat text list to a structured, hierarchical view with batch grouping and agent nesting, inspired by Claude Code CLI's presentation.

## Current State

Tool status is rendered as a flat markdown list in a single CardKit 2.0 element (`tool_status`):

```
✓ Read: src/index.ts (1.2s) → done
✓ Read: src/config.ts (0.8s) → done
✓ Edit: src/config.ts (1.5s) → done
🔧 Bash: npm test (5s)
```

- Max 5 visible, older items collapsed as "✓ 已完成 N 个工具调用"
- No hierarchy, no grouping, no agent distinction
- Rendering logic lives in `renderToolStatus()` in `src/messaging/inbound/dispatch.ts`

## Design Decisions

| Decision | Choice |
|----------|--------|
| Tree nesting depth | Max 2 levels (main task + 1 sub-agent). Deeper agents flattened into parent. |
| Batch grouping | Consecutive same-tool calls merged. Show count + file name list below. |
| Running status icon | `⏳` simple icon, no animation. |
| Done status icon | `✓` |
| Error status icon | `✗` |
| Collapse strategy | Completed agents collapse to 1-line summary. Main task tools truncate oldest (keep 5 visible). |

## Rendering Rules

### 1. Batch Grouping

Consecutive calls to the same tool are merged into one line:

```
✓ Read 3 files (2.1s)
  src/index.ts, src/config.ts, src/card/builder.ts
```

- Only group **consecutive** calls to the same tool name
- Show total elapsed time (sum of individual calls)
- File name list displayed below in smaller text (notation size)
- Detail field used for display: `file_path` for Read/Edit/Write, `command` for Bash, `pattern` for Grep/Glob

### 2. Agent Nesting (Max 2 Levels)

When a sub-agent is spawned, its tools are indented under an agent header:

```
✓ Read 2 files (1.8s)
  src/index.ts, src/config.ts
✓ Edit: src/config.ts (1.5s)
▶ Agent: code-reviewer
  ✓ Read 3 files (2.1s)
    src/card/builder.ts, src/card/streaming-card.ts, src/claude/executor.ts
  ⏳ Edit: src/card/builder.ts (2s...)
```

- Agent header: `▶ Agent: <name>` (blue/highlighted)
- Sub-agent tools indented with 2-space prefix
- If a sub-agent spawns another agent, flatten it into the parent sub-agent level (no 3rd level)

### 3. Collapse Strategy

**Completed agents** collapse to a single summary line:

```
✓ Agent: code-reviewer (5 tools, 8.7s)
```

This replaces the entire expanded agent block once all its tools finish.

**Main task tools** use count-based truncation (keep most recent 5 visible):

```
✓ 已完成 3 次工具调用
✓ Bash: npm test (4.1s)
✓ Agent: code-reviewer (5 tools, 8.7s)
⏳ Bash: npx tsc --noEmit (6s...)
```

### 4. Status Icons

| State | Icon | Suffix |
|-------|------|--------|
| Running | `⏳` | `(Ns...)` with live elapsed |
| Done | `✓` | `(Ns)` final elapsed |
| Error | `✗` | `(Ns)` + error hint |

## Data Model Changes

### ToolCallInfo Enhancement

```typescript
interface ToolCallInfo {
  toolUseId: string;
  name: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  resultSummary?: string;
  // New fields:
  agentId?: string;        // Which agent this tool belongs to (null = main task)
  parentAgentId?: string;   // For nested agent detection
}

interface AgentInfo {
  agentId: string;
  name: string;
  status: 'running' | 'done';
  parentAgentId?: string;
  toolCount: number;
  totalElapsedMs: number;
}
```

### Rendering State

```typescript
interface ToolRenderState {
  mainTools: ToolCallInfo[];       // Top-level tool calls
  agents: Map<string, AgentInfo>;  // Agent metadata
  agentTools: Map<string, ToolCallInfo[]>;  // Tools per agent
}
```

## Files to Modify

1. **`src/messaging/inbound/dispatch.ts`** — `renderToolStatus()` rewrite, `ToolCallInfo` enhancement, agent tracking in callbacks
2. **`src/claude/executor.ts`** — Detect agent spawn/complete events from SDK messages, add `onAgentStart`/`onAgentEnd` callbacks
3. **`src/card/builder.ts`** — Update `ToolStatus` interface (if still used), potentially add helper for notation-size sub-lines

## Rendering Output

The `renderToolStatus()` function continues to produce a markdown string for the `tool_status` CardKit element. No new CardKit elements or components needed — the improvement is purely in the markdown content structure using indentation and text formatting.

## Edge Cases

- **No agent events from SDK**: If the SDK doesn't expose agent spawn/complete events cleanly, fall back to heuristic detection (e.g., Agent tool_use block = agent start, its tool_result = agent end)
- **Rapid tool calls**: Batch grouping only applies to consecutive same-tool calls. Interleaved calls (Read, Edit, Read) are not grouped.
- **Very long file names**: Truncate individual file names at 40 chars in the file list. Full path shown for the most recent/running tool.
- **Agent with 0 tools**: Show as `✓ Agent: <name> (0s)` — don't hide it, the user should know it was spawned.
