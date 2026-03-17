export class DebouncedUpdater {
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentDelayMs: number;

  constructor(
    private updateFn: (content: string) => Promise<void>,
    private baseDelayMs: number = 500,
  ) {
    this.currentDelayMs = baseDelayMs;
  }

  schedule(content: string): void {
    this.pending = content;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.currentDelayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const content = this.pending;
    this.pending = null;
    try {
      await this.updateFn(content);
      this.currentDelayMs = this.baseDelayMs;
    } catch (err: any) {
      if (err?.response?.status === 429 || err?.code === 429) {
        this.currentDelayMs = Math.min(this.currentDelayMs * 2, 5000);
      }
      this.pending = content;
      this.timer = setTimeout(() => this.flush(), this.currentDelayMs);
    }
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
