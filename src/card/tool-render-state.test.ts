import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRenderState } from './tool-render-state.js';

// ---------------------------------------------------------------------------
// 1. Basic tool tracking
// ---------------------------------------------------------------------------
describe('Basic tool tracking', () => {
  it('renders a single running tool without elapsed', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    expect(state.render()).toBe('⏳ Read: src/index.ts');
  });

  it('renders a single running tool with elapsed', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    state.updateToolElapsed('t1', 5);
    expect(state.render()).toBe('⏳ Read: src/index.ts (5s...)');
  });

  it('renders a done tool with elapsed', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    state.completeTool('t1', 'done', 1.2);
    expect(state.render()).toBe('✓ Read: src/index.ts (1.2s)');
  });

  it('renders an error tool', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    state.completeTool('t1', 'error', 0.5);
    expect(state.render()).toBe('✗ Read: src/index.ts (0.5s)');
  });

  it('renders done tool without elapsed', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    state.completeTool('t1', 'done');
    expect(state.render()).toBe('✓ Read: src/index.ts');
  });
});

// ---------------------------------------------------------------------------
// 2. Batch grouping
// ---------------------------------------------------------------------------
describe('Batch grouping', () => {
  it('merges consecutive completed calls to the same tool', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/index.ts' });
    state.completeTool('t1', 'done', 1.0);
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/config.ts' });
    state.completeTool('t2', 'done', 0.8);

    const rendered = state.render();
    expect(rendered).toContain('✓ Read 2 files (1.8s)');
    expect(rendered).toContain('src/index.ts, src/config.ts');
  });

  it('uses "commands" noun for Bash tool', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Bash', detail: 'ls' });
    state.completeTool('t1', 'done', 0.5);
    state.addTool({ toolUseId: 't2', name: 'Bash', detail: 'pwd' });
    state.completeTool('t2', 'done', 0.3);

    const rendered = state.render();
    expect(rendered).toContain('✓ Bash 2 commands (0.8s)');
  });

  it('does not merge non-consecutive same-tool calls', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts' });
    state.completeTool('t1', 'done', 1.0);
    state.addTool({ toolUseId: 't2', name: 'Edit', detail: 'src/a.ts' });
    state.completeTool('t2', 'done', 0.5);
    state.addTool({ toolUseId: 't3', name: 'Read', detail: 'src/b.ts' });
    state.completeTool('t3', 'done', 0.8);

    const rendered = state.render();
    // Reads should NOT be merged since Edit is between them
    expect(rendered).toContain('✓ Read: src/a.ts');
    expect(rendered).toContain('✓ Read: src/b.ts');
  });

  it('does not batch running tools', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts' });
    state.completeTool('t1', 'done', 1.0);
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/b.ts' });
    // t2 is still running

    const rendered = state.render();
    // t1 done alone, t2 running alone — no batch
    expect(rendered).toContain('✓ Read: src/a.ts');
    expect(rendered).toContain('⏳ Read: src/b.ts');
  });

  it('merges 3+ consecutive completed calls', () => {
    const state = new ToolRenderState();
    for (let i = 1; i <= 3; i++) {
      state.addTool({ toolUseId: `t${i}`, name: 'Read', detail: `src/file${i}.ts` });
      state.completeTool(`t${i}`, 'done', 1.0);
    }

    const rendered = state.render();
    expect(rendered).toContain('✓ Read 3 files (3.0s)');
    expect(rendered).toContain('src/file1.ts, src/file2.ts, src/file3.ts');
  });
});

// ---------------------------------------------------------------------------
// 3. Truncation
// ---------------------------------------------------------------------------
describe('Truncation', () => {
  it('shows summary line for old completed items beyond MAX_VISIBLE=5', () => {
    const state = new ToolRenderState();
    // Add 7 tools with alternating names to prevent batch grouping
    const names = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Read'];
    for (let i = 1; i <= 7; i++) {
      // Alternate names so consecutive tools differ (no batching)
      state.addTool({ toolUseId: `t${i}`, name: names[i - 1], detail: `src/file${i}.ts` });
      state.completeTool(`t${i}`, 'done', 1.0);
    }

    const rendered = state.render();
    const lines = rendered.split('\n').filter(l => l.trim());

    // Should have summary + 5 visible = 6 lines total
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain('✓ 已完成 2 次工具调用');
    // Last 5 items visible (t3 through t7)
    for (let i = 3; i <= 7; i++) {
      expect(rendered).toContain(`src/file${i}.ts`);
    }
    // First 2 hidden (t1, t2)
    expect(rendered).not.toContain('src/file1.ts');
    expect(rendered).not.toContain('src/file2.ts');
  });

  it('does not truncate when exactly 5 items', () => {
    const state = new ToolRenderState();
    for (let i = 1; i <= 5; i++) {
      state.addTool({ toolUseId: `t${i}`, name: 'Edit', detail: `src/file${i}.ts` });
      state.completeTool(`t${i}`, 'done', 1.0);
    }

    const rendered = state.render();
    expect(rendered).not.toContain('已完成');
  });
});

// ---------------------------------------------------------------------------
// 4. Agent nesting
// ---------------------------------------------------------------------------
describe('Agent nesting', () => {
  it('renders a running agent with indented tools', () => {
    const state = new ToolRenderState();
    state.addAgent('a1', 'researcher');
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: 'a1' });

    const rendered = state.render();
    expect(rendered).toContain('▶ Agent: researcher');
    expect(rendered).toContain('  ⏳ Read: src/a.ts');
  });

  it('collapses completed agent to single line', () => {
    const state = new ToolRenderState();
    state.addAgent('a1', 'researcher');
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: 'a1' });
    state.completeTool('t1', 'done', 1.0);
    state.addTool({ toolUseId: 't2', name: 'Edit', detail: 'src/b.ts', parentToolUseId: 'a1' });
    state.completeTool('t2', 'done', 2.0);
    state.completeAgent('a1');

    const rendered = state.render();
    // Collapsed line with tool count and total elapsed
    expect(rendered).toContain('✓ Agent: researcher (2 tools, 3.0s)');
    // No sub-lines for collapsed agent
    expect(rendered).not.toContain('⏳');
    expect(rendered).not.toContain('  ');
  });

  it('batches consecutive same-tool calls inside agent', () => {
    const state = new ToolRenderState();
    state.addAgent('a1', 'reader');
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/a.ts', parentToolUseId: 'a1' });
    state.completeTool('t1', 'done', 1.0);
    state.addTool({ toolUseId: 't2', name: 'Read', detail: 'src/b.ts', parentToolUseId: 'a1' });
    state.completeTool('t2', 'done', 0.8);

    const rendered = state.render();
    expect(rendered).toContain('  ✓ Read 2 files (1.8s)');
    expect(rendered).toContain('    src/a.ts, src/b.ts');
  });

  it('treats deeply nested agents (agent inside agent) as regular tool of parent', () => {
    const state = new ToolRenderState();
    state.addAgent('a1', 'outer');
    // Inner agent registered as child of outer
    state.addAgent('a2', 'inner');
    // Manually set parentToolUseId for inner agent — represented as tool entry
    state.addTool({ toolUseId: 'fake-inner', name: 'Agent', detail: 'inner', parentToolUseId: 'a1' });
    state.completeTool('fake-inner', 'done', 2.0);

    const rendered = state.render();
    // Inner agent shown as indented tool line, not 3rd level
    expect(rendered).toContain('▶ Agent: outer');
    expect(rendered).toContain('  ✓ Agent: inner (2.0s)');
  });

  it('renders multiple agents interleaved with top-level tools', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 't1', name: 'Read', detail: 'src/main.ts' });
    state.completeTool('t1', 'done', 0.5);
    state.addAgent('a1', 'worker');
    state.addTool({ toolUseId: 't2', name: 'Edit', detail: 'src/x.ts', parentToolUseId: 'a1' });
    state.completeTool('t2', 'done', 1.0);
    state.completeAgent('a1');
    state.addTool({ toolUseId: 't3', name: 'Read', detail: 'src/y.ts' });
    state.completeTool('t3', 'done', 0.3);

    const rendered = state.render();
    expect(rendered).toContain('✓ Read: src/main.ts');
    expect(rendered).toContain('✓ Agent: worker');
    expect(rendered).toContain('✓ Read: src/y.ts');
  });
});

// ---------------------------------------------------------------------------
// 5. Integration: full session
// ---------------------------------------------------------------------------
describe('Integration: full session', () => {
  it('handles a realistic session flow', () => {
    const state = new ToolRenderState();

    // Initial reads
    state.addTool({ toolUseId: 'r1', name: 'Read', detail: 'src/index.ts' });
    state.completeTool('r1', 'done', 0.5);
    state.addTool({ toolUseId: 'r2', name: 'Read', detail: 'src/config.ts' });
    state.completeTool('r2', 'done', 0.3);

    // Edit
    state.addTool({ toolUseId: 'e1', name: 'Edit', detail: 'src/index.ts' });
    state.completeTool('e1', 'done', 1.2);

    // Agent with reads
    state.addAgent('ag1', 'analyzer');
    state.addTool({ toolUseId: 'ar1', name: 'Read', detail: 'src/a.ts', parentToolUseId: 'ag1' });
    state.completeTool('ar1', 'done', 0.4);
    state.addTool({ toolUseId: 'ar2', name: 'Read', detail: 'src/b.ts', parentToolUseId: 'ag1' });
    state.completeTool('ar2', 'done', 0.6);
    state.completeAgent('ag1');

    // More top-level tools
    state.addTool({ toolUseId: 'r3', name: 'Read', detail: 'src/final.ts' });
    state.completeTool('r3', 'done', 0.2);

    const rendered = state.render();

    // Batched reads at top
    expect(rendered).toContain('✓ Read 2 files (0.8s)');
    expect(rendered).toContain('src/index.ts, src/config.ts');

    // Edit as single line
    expect(rendered).toContain('✓ Edit: src/index.ts (1.2s)');

    // Collapsed agent
    expect(rendered).toContain('✓ Agent: analyzer (2 tools, 1.0s)');

    // Final read
    expect(rendered).toContain('✓ Read: src/final.ts (0.2s)');
  });

  it('shows running state mid-session', () => {
    const state = new ToolRenderState();
    state.addTool({ toolUseId: 'r1', name: 'Read', detail: 'src/a.ts' });
    state.completeTool('r1', 'done', 1.0);
    state.addTool({ toolUseId: 'r2', name: 'Read', detail: 'src/b.ts' });
    state.updateToolElapsed('r2', 3);

    const rendered = state.render();
    // r1 done alone (r2 is still running, not completed — no batch)
    expect(rendered).toContain('✓ Read: src/a.ts (1.0s)');
    expect(rendered).toContain('⏳ Read: src/b.ts (3s...)');
  });
});
