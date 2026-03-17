import { Database, type SessionRow } from './db.js';

export class SessionManager {
  private activeTasks = new Map<string, AbortController>();

  constructor(private db: Database) {}

  getOrCreate(userId: string, topicId: string | null, projectName: string): SessionRow {
    const existing = this.db.findSession(userId, topicId, projectName);
    if (existing) {
      this.db.touchSession(existing.id);
      return existing;
    }
    const id = this.db.createSession(userId, topicId, projectName);
    return this.db.findSession(userId, topicId, projectName)!;
  }

  reset(userId: string, topicId: string | null, projectName: string): void {
    const session = this.db.findSession(userId, topicId, projectName);
    if (session) {
      this.db.resetSession(session.id);
    }
  }

  hasActiveTask(userId: string): boolean {
    return this.activeTasks.has(userId);
  }

  setActiveTask(userId: string, controller: AbortController): void {
    this.activeTasks.set(userId, controller);
  }

  cancelTask(userId: string): void {
    const controller = this.activeTasks.get(userId);
    if (controller) {
      controller.abort();
      this.activeTasks.delete(userId);
    }
  }

  clearActiveTask(userId: string): void {
    this.activeTasks.delete(userId);
  }

  cancelAll(): void {
    for (const [userId, controller] of this.activeTasks) {
      controller.abort();
    }
    this.activeTasks.clear();
  }
}
