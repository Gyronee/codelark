export function buildQueueKey(chatId: string, threadId: string | null): string {
  return threadId ? `${chatId}:thread:${threadId}` : chatId;
}

export class ChatQueue {
  private queues = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).then(
      () => this.cleanup(key, next),
      () => this.cleanup(key, next),
    );
    this.queues.set(key, next);
  }

  hasActiveTask(key: string): boolean {
    return this.queues.has(key);
  }

  private cleanup(key: string, promise: Promise<void>): void {
    if (this.queues.get(key) === promise) this.queues.delete(key);
  }
}
