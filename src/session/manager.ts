import { Database, type SessionRow } from './db.js';

export class SessionManager {
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
}
