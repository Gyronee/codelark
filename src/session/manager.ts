import { Database, type SessionRow } from './db.js';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';

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

  getOrCreateGroup(chatId: string, threadId: string | null, projectName: string): SessionRow {
    const existing = this.db.findGroupSession(chatId, threadId, projectName);
    if (existing) {
      this.db.touchSession(existing.id);
      return existing;
    }
    return this.db.createGroupSession(chatId, threadId, projectName);
  }

  resetGroup(chatId: string, threadId: string | null, projectName: string): void {
    const session = this.db.findGroupSession(chatId, threadId, projectName);
    if (session) {
      this.db.resetSession(session.id);
    }
  }

  async fork(
    userId: string,
    topicId: string | null,
    projectName: string,
    sourceClaudeSessionId: string,
    cwd: string,
    title?: string,
  ): Promise<SessionRow> {
    const result = await forkSession(sourceClaudeSessionId, { dir: cwd, title });
    const newId = this.db.createSession(userId, topicId, projectName);
    this.db.updateClaudeSessionId(newId, result.sessionId);
    if (title) {
      this.db.setSessionTitle(newId, title);
    }
    // Ensure the forked session is the most recent (for getOrCreate lookup)
    this.db.touchSession(newId);
    return this.db.findBotSessionByIdPrefix(newId)!;
  }

  listAll(userId: string, topicId: string | null, projectName: string): SessionRow[] {
    return this.db.listSessions(userId, topicId, projectName);
  }
}
