import { describe, it, expect } from 'vitest';
import { FlushController } from './flush-controller.js';

describe('FlushController', () => {
  it('flushes after throttle', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => { updates.push(c); }, 50);
    fc.schedule('hello');
    expect(updates).toEqual([]);
    await new Promise(r => setTimeout(r, 100));
    expect(updates).toEqual(['hello']);
    fc.destroy();
  });

  it('coalesces rapid updates', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => { updates.push(c); }, 50);
    fc.schedule('a'); fc.schedule('b'); fc.schedule('c');
    await new Promise(r => setTimeout(r, 100));
    expect(updates).toEqual(['c']);
    fc.destroy();
  });

  it('reflushes if content arrives during flush', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => {
      updates.push(c);
      await new Promise(r => setTimeout(r, 50));
    }, 10);
    fc.schedule('first');
    await new Promise(r => setTimeout(r, 20));
    fc.schedule('second');
    await new Promise(r => setTimeout(r, 150));
    expect(updates).toContain('first');
    expect(updates).toContain('second');
    fc.destroy();
  });

  it('waitForFlush resolves after flush', async () => {
    const updates: string[] = [];
    const fc = new FlushController(async (c) => {
      await new Promise(r => setTimeout(r, 30));
      updates.push(c);
    }, 10);
    fc.schedule('data');
    await new Promise(r => setTimeout(r, 20));
    await fc.waitForFlush();
    expect(updates).toEqual(['data']);
    fc.destroy();
  });
});
