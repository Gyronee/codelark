export interface DedupOptions {
  maxSize: number;
  ttlMs: number;
  staleMs: number;
}

export class Dedup {
  private seen = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private opts: DedupOptions;

  constructor(opts?: Partial<DedupOptions>) {
    this.opts = {
      maxSize: opts?.maxSize ?? 5000,
      ttlMs: opts?.ttlMs ?? 12 * 60 * 60 * 1000,
      staleMs: opts?.staleMs ?? 120_000,
    };
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweepTimer.unref();
  }

  check(eventId: string, createTime: number): boolean {
    if (Date.now() - createTime > this.opts.staleMs) return false;
    if (this.seen.has(eventId)) return false;
    while (this.seen.size >= this.opts.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(eventId, Date.now());
    return true;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.opts.ttlMs) this.seen.delete(id);
      else break;
    }
  }

  destroy(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    this.seen.clear();
  }
}
