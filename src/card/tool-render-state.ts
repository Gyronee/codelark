// ---------------------------------------------------------------------------
// ToolRenderState — tracks tool calls and agent hierarchy for card rendering
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 5;

const BATCH_NOUN: Record<string, string> = {
  Bash: 'commands',
};

function batchNoun(toolName: string): string {
  return BATCH_NOUN[toolName] ?? 'files';
}

function formatElapsed(elapsed: number): string {
  // Always show 1 decimal place
  return `${elapsed.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolStatus = 'running' | 'done' | 'error';

interface ToolEntry {
  toolUseId: string;
  name: string;
  detail: string;
  status: ToolStatus;
  elapsed?: number;
  parentToolUseId?: string;
}

interface AgentEntry {
  toolUseId: string;
  name: string;
  completed: boolean;
  tools: string[]; // ordered list of child toolUseIds
}

interface MainOrderItem {
  type: 'tool' | 'agent';
  id: string;
}

// ---------------------------------------------------------------------------
// Batch group (for rendering)
// ---------------------------------------------------------------------------

interface BatchGroup {
  type: 'batch';
  toolName: string;
  entries: ToolEntry[];
}

interface SingleTool {
  type: 'single';
  entry: ToolEntry;
}

type RenderItem = BatchGroup | SingleTool;

// ---------------------------------------------------------------------------
// Core grouping logic
// ---------------------------------------------------------------------------

/**
 * Takes an ordered list of ToolEntry and collapses consecutive completed
 * same-name tools into batch groups. Running tools are never batched.
 */
function groupTools(entries: ToolEntry[]): RenderItem[] {
  const result: RenderItem[] = [];

  for (const entry of entries) {
    const isCompleted = entry.status === 'done' || entry.status === 'error';

    if (
      isCompleted &&
      result.length > 0
    ) {
      const last = result[result.length - 1];
      if (
        last.type === 'batch' &&
        last.toolName === entry.name &&
        // Only batch done items into done batches (not error)
        entry.status === 'done' &&
        last.entries.every(e => e.status === 'done')
      ) {
        last.entries.push(entry);
        continue;
      }
      if (
        last.type === 'single' &&
        last.entry.name === entry.name &&
        last.entry.status === 'done' &&
        entry.status === 'done'
      ) {
        // Promote to batch
        result[result.length - 1] = {
          type: 'batch',
          toolName: entry.name,
          entries: [last.entry, entry],
        };
        continue;
      }
    }

    result.push({ type: 'single', entry });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderSingleTool(entry: ToolEntry, indent = ''): string {
  const icon = entry.status === 'running' ? '⏳' : entry.status === 'done' ? '✓' : '✗';
  let line = `${indent}${icon} ${entry.name}: ${entry.detail}`;
  if (entry.elapsed !== undefined) {
    if (entry.status === 'running') {
      line += ` (${entry.elapsed}s...)`;
    } else {
      line += ` (${formatElapsed(entry.elapsed)})`;
    }
  }
  return line;
}

function renderBatchGroup(group: BatchGroup, indent = ''): string {
  const totalElapsed = group.entries.reduce((sum, e) => sum + (e.elapsed ?? 0), 0);
  const noun = batchNoun(group.toolName);
  const count = group.entries.length;
  const elapsedStr = formatElapsed(totalElapsed);
  const header = `${indent}✓ ${group.toolName} ${count} ${noun} (${elapsedStr})`;
  const details = group.entries.map(e => e.detail).join(', ');
  const detailIndent = indent + '  ';
  return `${header}\n${detailIndent}${details}`;
}

function renderItems(items: RenderItem[], indent = ''): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === 'single') {
      lines.push(renderSingleTool(item.entry, indent));
    } else {
      lines.push(renderBatchGroup(item, indent));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// ToolRenderState
// ---------------------------------------------------------------------------

export class ToolRenderState {
  private toolIndex: Map<string, ToolEntry> = new Map();
  private agentIndex: Map<string, AgentEntry> = new Map();
  private mainOrder: MainOrderItem[] = [];

  // -------------------------------------------------------------------------
  // Mutators
  // -------------------------------------------------------------------------

  addTool(opts: {
    toolUseId: string;
    name: string;
    detail: string;
    parentToolUseId?: string;
  }): void {
    const entry: ToolEntry = {
      toolUseId: opts.toolUseId,
      name: opts.name,
      detail: opts.detail,
      status: 'running',
      parentToolUseId: opts.parentToolUseId,
    };

    this.toolIndex.set(opts.toolUseId, entry);

    if (opts.parentToolUseId && this.agentIndex.has(opts.parentToolUseId)) {
      // Child of a known agent
      this.agentIndex.get(opts.parentToolUseId)!.tools.push(opts.toolUseId);
    } else {
      // Top-level tool
      this.mainOrder.push({ type: 'tool', id: opts.toolUseId });
    }
  }

  completeTool(toolUseId: string, status: 'done' | 'error', elapsed?: number): void {
    const entry = this.toolIndex.get(toolUseId);
    if (!entry) return;
    entry.status = status;
    if (elapsed !== undefined) entry.elapsed = elapsed;
  }

  updateToolElapsed(toolUseId: string, elapsed: number): void {
    const entry = this.toolIndex.get(toolUseId);
    if (!entry) return;
    entry.elapsed = elapsed;
  }

  addAgent(toolUseId: string, name: string): void {
    const agent: AgentEntry = { toolUseId, name, completed: false, tools: [] };
    this.agentIndex.set(toolUseId, agent);
    this.mainOrder.push({ type: 'agent', id: toolUseId });
  }

  completeAgent(toolUseId: string): void {
    const agent = this.agentIndex.get(toolUseId);
    if (!agent) return;
    agent.completed = true;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): string {
    return this._applyTruncation().join('\n');
  }

  private _renderAgent(agent: AgentEntry): string[] {
    if (agent.completed) {
      // Collapsed: single line with tool count and total elapsed
      const toolEntries = agent.tools
        .map(id => this.toolIndex.get(id))
        .filter(Boolean) as ToolEntry[];
      const toolCount = toolEntries.length;
      const totalElapsed = toolEntries.reduce((sum, e) => sum + (e.elapsed ?? 0), 0);
      const elapsedStr = formatElapsed(totalElapsed);
      return [`✓ Agent: ${agent.name} (${toolCount} tools, ${elapsedStr})`];
    }

    // Running agent: header + indented tools
    const headerLine = `▶ Agent: ${agent.name}`;
    const toolEntries = agent.tools
      .map(id => this.toolIndex.get(id))
      .filter(Boolean) as ToolEntry[];
    const grouped = groupTools(toolEntries);
    const subLines = renderItems(grouped, '  ');
    return [headerLine, ...subLines];
  }

  /**
   * Apply truncation: if logical item count > MAX_VISIBLE, hide oldest
   * completed items behind a summary line.
   * Output: summary + MAX_VISIBLE items = MAX_VISIBLE + 1 lines.
   */
  private _applyTruncation(): string[] {
    const itemLines = this._getPerItemLines();

    if (itemLines.length <= MAX_VISIBLE) {
      return itemLines.flatMap(i => i.lines.flatMap(l => l.split('\n')));
    }

    // Need to hide (itemLines.length - MAX_VISIBLE) oldest completed items
    const toHide = itemLines.length - MAX_VISIBLE;
    let hiddenToolCalls = 0;
    let cutIndex = 0;

    for (let i = 0; i < itemLines.length && cutIndex < toHide; i++) {
      const item = itemLines[i];
      if (!item.isRunning) {
        hiddenToolCalls += item.toolCount;
        cutIndex = i + 1;
      } else {
        break; // Stop at first running item
      }
    }

    if (hiddenToolCalls === 0) {
      return itemLines.flatMap(i => i.lines.flatMap(l => l.split('\n')));
    }

    const summaryLine = `✓ 已完成 ${hiddenToolCalls} 次工具调用`;
    const visible = itemLines.slice(cutIndex).flatMap(i => i.lines.flatMap(l => l.split('\n')));
    return [summaryLine, ...visible];
  }

  /** Get per-item rendered lines with metadata for truncation */
  private _getPerItemLines(): Array<{ lines: string[]; isRunning: boolean; toolCount: number }> {
    const result: Array<{ lines: string[]; isRunning: boolean; toolCount: number }> = [];

    let pendingTools: ToolEntry[] = [];

    const flushPending = () => {
      if (pendingTools.length === 0) return;
      const grouped = groupTools(pendingTools);
      for (const item of grouped) {
        if (item.type === 'single') {
          const isRunning = item.entry.status === 'running';
          result.push({
            lines: [renderSingleTool(item.entry)],
            isRunning,
            toolCount: 1,
          });
        } else {
          result.push({
            lines: [renderBatchGroup(item)],
            isRunning: false,
            toolCount: item.entries.length,
          });
        }
      }
      pendingTools = [];
    };

    for (const item of this.mainOrder) {
      if (item.type === 'tool') {
        const entry = this.toolIndex.get(item.id);
        if (entry) pendingTools.push(entry);
      } else {
        flushPending();
        const agent = this.agentIndex.get(item.id);
        if (agent) {
          const agentLines = this._renderAgent(agent);
          result.push({
            lines: agentLines,
            isRunning: !agent.completed,
            toolCount: agent.tools.length || 1,
          });
        }
      }
    }
    flushPending();

    return result;
  }
}
