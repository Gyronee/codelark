import { describe, it, expect } from 'vitest';
import { CardBuilder, sanitizeMarkdown } from './builder.js';

describe('CardBuilder', () => {
  it('builds thinking card', () => {
    const c = CardBuilder.thinking('my-app');
    expect(c.header.template).toBe('blue');
    expect(c.header.title.content).toContain('my-app');
  });
  it('builds working card', () => {
    const c = CardBuilder.working('my-app', 'Analyzing...', [{ tool: 'Read', status: 'done', detail: 'src/index.ts' }]);
    expect(c.header.template).toBe('orange');
    expect(JSON.stringify(c)).toContain('Analyzing...');
  });
  it('builds done card', () => {
    const c = CardBuilder.done('my-app', 'Result', 3);
    expect(c.header.template).toBe('green');
  });
  it('builds error card', () => {
    expect(CardBuilder.error('my-app', 'broke').header.template).toBe('red');
  });
  it('builds confirm card', () => {
    const j = JSON.stringify(CardBuilder.confirm('my-app', 'rm -rf /', 't1'));
    expect(j).toContain('rm -rf /');
    expect(j).toContain('t1');
  });
  it('builds cancelled card', () => {
    expect(CardBuilder.cancelled('my-app').header.title.content).toContain('my-app');
  });
  it('builds fallback text', () => {
    expect(CardBuilder.buildFallbackText('**bold** text')).toBe('bold text');
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
