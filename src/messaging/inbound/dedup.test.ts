import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Dedup } from './dedup.js';

describe('Dedup', () => {
  let dedup: Dedup;
  beforeEach(() => { dedup = new Dedup({ maxSize: 5, ttlMs: 60_000, staleMs: 120_000 }); });
  afterEach(() => { dedup.destroy(); });

  it('allows first occurrence', () => {
    expect(dedup.check('evt_1', Date.now())).toBe(true);
  });
  it('rejects duplicate', () => {
    dedup.check('evt_1', Date.now());
    expect(dedup.check('evt_1', Date.now())).toBe(false);
  });
  it('rejects stale by create_time', () => {
    expect(dedup.check('evt_new', Date.now() - 200_000)).toBe(false);
  });
  it('evicts oldest at capacity', () => {
    for (let i = 0; i < 5; i++) dedup.check(`evt_${i}`, Date.now());
    dedup.check('evt_5', Date.now());
    expect(dedup.check('evt_0', Date.now())).toBe(true);
  });
  it('allows after TTL sweep', async () => {
    const short = new Dedup({ maxSize: 100, ttlMs: 50, staleMs: 120_000 });
    short.check('evt_1', Date.now());
    await new Promise(r => setTimeout(r, 100));
    short.sweep();
    expect(short.check('evt_1', Date.now())).toBe(true);
    short.destroy();
  });
});
