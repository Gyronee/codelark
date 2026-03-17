import { describe, it, expect } from 'vitest';
import { ChatQueue, buildQueueKey } from './chat-queue.js';

describe('buildQueueKey', () => {
  it('uses chatId when no threadId', () => { expect(buildQueueKey('oc_123', null)).toBe('oc_123'); });
  it('includes threadId', () => { expect(buildQueueKey('oc_123', 't_1')).toBe('oc_123:thread:t_1'); });
});

describe('ChatQueue', () => {
  it('serial for same key', async () => {
    const q = new ChatQueue(); const order: number[] = [];
    q.enqueue('a', async () => { await new Promise(r => setTimeout(r, 50)); order.push(1); });
    q.enqueue('a', async () => { order.push(2); });
    await new Promise(r => setTimeout(r, 150));
    expect(order).toEqual([1, 2]);
  });
  it('parallel for different keys', async () => {
    const q = new ChatQueue(); const order: string[] = [];
    q.enqueue('a', async () => { await new Promise(r => setTimeout(r, 50)); order.push('a'); });
    q.enqueue('b', async () => { order.push('b'); });
    await new Promise(r => setTimeout(r, 100));
    expect(order).toEqual(['b', 'a']);
  });
  it('continues after throw', async () => {
    const q = new ChatQueue(); const r: string[] = [];
    q.enqueue('a', async () => { throw new Error('fail'); });
    q.enqueue('a', async () => { r.push('ok'); });
    await new Promise(res => setTimeout(res, 50));
    expect(r).toEqual(['ok']);
  });
  it('cleans up after last task', async () => {
    const q = new ChatQueue();
    q.enqueue('a', async () => {});
    await new Promise(r => setTimeout(r, 50));
    expect(q.hasActiveTask('a')).toBe(false);
  });
});
