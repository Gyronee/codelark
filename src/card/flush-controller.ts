const LONG_GAP_MS = 2000;
const BATCH_AFTER_GAP_MS = 200;

export class FlushController {
  private pendingContent: string | null = null;
  private flushInProgress = false;
  private needsReflush = false;
  private lastUpdateTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushResolvers: Array<() => void> = [];

  constructor(
    private updateFn: (content: string) => Promise<void>,
    private throttleMs: number = 500,
  ) {}

  schedule(content: string): void {
    this.pendingContent = content;
    if (this.flushInProgress) { this.needsReflush = true; return; }
    if (this.timer) return;
    const elapsed = Date.now() - this.lastUpdateTime;
    if (this.lastUpdateTime === 0) { this.timer = setTimeout(() => this.doFlush(), 0); }
    else if (elapsed > LONG_GAP_MS) { this.timer = setTimeout(() => this.doFlush(), BATCH_AFTER_GAP_MS); }
    else if (elapsed < this.throttleMs) { this.timer = setTimeout(() => this.doFlush(), this.throttleMs - elapsed); }
    else { this.timer = setTimeout(() => this.doFlush(), 0); }
  }

  private async doFlush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pendingContent === null) return;
    this.flushInProgress = true;
    const content = this.pendingContent;
    this.pendingContent = null;
    this.lastUpdateTime = Date.now();
    try { await this.updateFn(content); }
    catch { if (this.pendingContent === null) this.pendingContent = content; }
    this.flushInProgress = false;
    const resolvers = this.flushResolvers;
    this.flushResolvers = [];
    resolvers.forEach(r => r());
    if (this.needsReflush) {
      this.needsReflush = false;
      if (this.pendingContent !== null) setTimeout(() => this.doFlush(), 0);
    }
  }

  async waitForFlush(): Promise<void> {
    if (!this.flushInProgress && this.pendingContent === null) return;
    if (!this.flushInProgress && this.pendingContent !== null) { await this.doFlush(); return; }
    return new Promise(resolve => { this.flushResolvers.push(resolve); });
  }

  destroy(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
