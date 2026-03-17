import { describe, it, expect } from 'vitest';
import { CardBuilder, sanitizeMarkdown } from './builder.js';

describe('CardBuilder', () => {
  it('builds thinking card with header', () => {
    const c = CardBuilder.thinking('my-app');
    expect(c.header?.template).toBe('blue');
    expect(c.header?.title.content).toContain('my-app');
  });
  it('builds working card with header', () => {
    const c = CardBuilder.working('my-app', 'Analyzing...', [{ tool: 'Read', status: 'done', detail: 'src/index.ts' }]);
    expect(c.header?.template).toBe('orange');
    expect(JSON.stringify(c)).toContain('Analyzing...');
  });
  it('builds done card without header, with footer', () => {
    const c = CardBuilder.done('my-app', 'Result', 3, { elapsedMs: 5000 });
    expect(c.header).toBeUndefined();
    const json = JSON.stringify(c);
    expect(json).toContain('Result');
    expect(json).toContain('已完成');
    expect(json).toContain('5.0s');
  });
  it('builds done card with reasoning panel', () => {
    const c = CardBuilder.done('my-app', 'Answer', 0, { reasoningText: 'I think...', reasoningElapsedMs: 3200 });
    const json = JSON.stringify(c);
    expect(json).toContain('collapsible_panel');
    expect(json).toContain('3.2s');
  });
  it('builds error card without header, with red footer', () => {
    const c = CardBuilder.error('my-app', 'broke', 2000);
    expect(c.header).toBeUndefined();
    const json = JSON.stringify(c);
    expect(json).toContain('broke');
    expect(json).toContain('出错');
  });
  it('builds confirm card with header', () => {
    const j = JSON.stringify(CardBuilder.confirm('my-app', 'rm -rf /', 't1'));
    expect(j).toContain('rm -rf /');
    expect(j).toContain('t1');
  });
  it('builds cancelled card without header', () => {
    const c = CardBuilder.cancelled('my-app');
    expect(c.header).toBeUndefined();
    expect(JSON.stringify(c)).toContain('已停止');
  });
  it('builds fallback text', () => {
    expect(CardBuilder.buildFallbackText('**bold** text')).toBe('bold text');
  });
  it('toCardKit2 handles headerless cards', () => {
    const c = CardBuilder.done('p', 'text', 0);
    const kit = CardBuilder.toCardKit2(c) as any;
    expect(kit.schema).toBe('2.0');
    expect(kit.header).toBeUndefined();
    expect(kit.body.elements.length).toBeGreaterThan(0);
  });
});

describe('sanitizeMarkdown', () => {
  it('passes short text', () => { expect(sanitizeMarkdown('hello')).toBe('hello'); });
  it('truncates long text', () => {
    const r = sanitizeMarkdown('a'.repeat(5000), 2000);
    expect(r.length).toBeLessThanOrEqual(2100);
    expect(r).toContain('...');
  });
});
