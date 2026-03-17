import { describe, it, expect } from 'vitest';
import { CardBuilder, sanitizeMarkdown } from './cards.js';

describe('CardBuilder', () => {
  it('builds a thinking card', () => {
    const card = CardBuilder.thinking('my-app');
    expect(card).toHaveProperty('header');
    expect(card.header.title.content).toContain('my-app');
  });

  it('builds a working card with text and tool status', () => {
    const card = CardBuilder.working('my-app', 'Analyzing code...', [
      { tool: 'Read', status: 'done', detail: 'src/index.ts' },
      { tool: 'Edit', status: 'running', detail: 'src/utils.ts' },
    ]);
    const json = JSON.stringify(card);
    expect(json).toContain('Analyzing code...');
    expect(json).toContain('src/index.ts');
  });

  it('builds a done card', () => {
    const card = CardBuilder.done('my-app', 'Here is the result', 3);
    const json = JSON.stringify(card);
    expect(json).toContain('Here is the result');
  });

  it('builds an error card', () => {
    const card = CardBuilder.error('my-app', 'Something went wrong');
    const json = JSON.stringify(card);
    expect(json).toContain('Something went wrong');
  });

  it('builds a confirm card', () => {
    const card = CardBuilder.confirm('my-app', 'git push origin main', 'task-123');
    const json = JSON.stringify(card);
    expect(json).toContain('git push origin main');
  });
});

describe('sanitizeMarkdown', () => {
  it('passes through simple markdown', () => {
    expect(sanitizeMarkdown('Hello **world**')).toBe('Hello **world**');
  });

  it('truncates very long content', () => {
    const long = 'a'.repeat(5000);
    const result = sanitizeMarkdown(long, 2000);
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result).toContain('...');
  });
});
