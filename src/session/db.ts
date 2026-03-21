import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface UserRow {
  feishu_user_id: string;
  name: string | null;
  active_project: string | null;
  active_cwd: string | null;
  resumed_session_id: string | null;
  resumed_cwd: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  feishu_user_id: string;
  topic_id: string | null;
  project_name: string;
  claude_session_id: string | null;
  last_active_at: string | null;
  created_at: string;
}

export interface TaskLogRow {
  id: number;
  session_id: string;
  user_message: string | null;
  assistant_message: string | null;
  tools_used: string | null;
  duration_ms: number | null;
  status: string | null;
  created_at: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;      // Unix ms
  refreshExpiresAt: number; // Unix ms
  scope: string;
  grantedAt: number;      // Unix ms
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        feishu_user_id TEXT PRIMARY KEY,
        name TEXT,
        active_project TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        feishu_user_id TEXT NOT NULL,
        topic_id TEXT,
        project_name TEXT NOT NULL,
        claude_session_id TEXT,
        last_active_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_message TEXT,
        assistant_message TEXT,
        tools_used TEXT,
        duration_ms INTEGER,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        feishu_user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        granted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_bindings (
        chat_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_name TEXT,
        creator_user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, thread_id)
      );
    `);

    try {
      this.db.exec('ALTER TABLE users ADD COLUMN resumed_session_id TEXT;');
    } catch {
      // column already exists
    }

    try {
      this.db.exec('ALTER TABLE users ADD COLUMN resumed_cwd TEXT;');
    } catch {
      // column already exists
    }

    try {
      this.db.exec('ALTER TABLE users ADD COLUMN active_cwd TEXT;');
    } catch {
      // column already exists
    }
  }

  upsertUser(feishuUserId: string, name: string | null): void {
    this.db.prepare(`
      INSERT INTO users (feishu_user_id, name)
      VALUES (?, ?)
      ON CONFLICT(feishu_user_id) DO UPDATE SET name = excluded.name
    `).run(feishuUserId, name);
  }

  getUser(feishuUserId: string): UserRow | null {
    return this.db.prepare('SELECT * FROM users WHERE feishu_user_id = ?')
      .get(feishuUserId) as UserRow | null;
  }

  setActiveProject(feishuUserId: string, projectName: string | null): void {
    this.db.prepare('UPDATE users SET active_project = ?, active_cwd = NULL WHERE feishu_user_id = ?')
      .run(projectName, feishuUserId);
  }

  setActiveProjectWithCwd(feishuUserId: string, projectName: string, cwd: string): void {
    this.db.prepare('UPDATE users SET active_project = ?, active_cwd = ? WHERE feishu_user_id = ?')
      .run(projectName, cwd, feishuUserId);
  }

  setResumedSession(feishuUserId: string, sessionId: string, cwd: string): void {
    this.db.prepare('UPDATE users SET resumed_session_id = ?, resumed_cwd = ? WHERE feishu_user_id = ?')
      .run(sessionId, cwd, feishuUserId);
  }

  clearResumedSession(feishuUserId: string): void {
    this.db.prepare('UPDATE users SET resumed_session_id = NULL, resumed_cwd = NULL WHERE feishu_user_id = ?')
      .run(feishuUserId);
  }

  createSession(feishuUserId: string, topicId: string | null, projectName: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO sessions (id, feishu_user_id, topic_id, project_name, last_active_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, feishuUserId, topicId, projectName);
    return id;
  }

  findSession(feishuUserId: string, topicId: string | null, projectName: string): SessionRow | null {
    let row: unknown;
    if (topicId) {
      row = this.db.prepare(`
        SELECT * FROM sessions
        WHERE feishu_user_id = ? AND topic_id = ? AND project_name = ?
        ORDER BY last_active_at DESC LIMIT 1
      `).get(feishuUserId, topicId, projectName);
    } else {
      row = this.db.prepare(`
        SELECT * FROM sessions
        WHERE feishu_user_id = ? AND topic_id IS NULL AND project_name = ?
        ORDER BY last_active_at DESC LIMIT 1
      `).get(feishuUserId, projectName);
    }
    return (row ?? null) as SessionRow | null;
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.db.prepare(`
      UPDATE sessions SET claude_session_id = ?, last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(claudeSessionId, sessionId);
  }

  touchSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(sessionId);
  }

  resetSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET claude_session_id = NULL WHERE id = ?')
      .run(sessionId);
  }

  logTask(
    sessionId: string,
    userMessage: string | null,
    assistantMessage: string | null,
    toolsUsed: string | null,
    durationMs: number | null,
    status: string
  ): void {
    this.db.prepare(`
      INSERT INTO task_logs (session_id, user_message, assistant_message, tools_used, duration_ms, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, userMessage, assistantMessage, toolsUsed, durationMs, status);
  }

  getTaskLogs(sessionId: string, limit: number): TaskLogRow[] {
    return this.db.prepare(
      'SELECT * FROM task_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, limit) as TaskLogRow[];
  }

  saveToken(feishuUserId: string, token: OAuthToken): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO oauth_tokens (feishu_user_id, access_token, refresh_token, expires_at, refresh_expires_at, scope, granted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(feishuUserId, token.accessToken, token.refreshToken, token.expiresAt, token.refreshExpiresAt, token.scope, token.grantedAt);
  }

  getToken(feishuUserId: string): OAuthToken | null {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE feishu_user_id = ?')
      .get(feishuUserId) as { access_token: string; refresh_token: string; expires_at: number; refresh_expires_at: number; scope: string; granted_at: number } | undefined;
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      scope: row.scope,
      grantedAt: row.granted_at,
    };
  }

  deleteToken(feishuUserId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE feishu_user_id = ?')
      .run(feishuUserId);
  }

  ensureThreadCreator(chatId: string, threadId: string, creatorUserId: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO thread_bindings (chat_id, thread_id, creator_user_id) VALUES (?, ?, ?)'
    ).run(chatId, threadId, creatorUserId);
  }

  setThreadBinding(chatId: string, threadId: string, projectName: string, boundBy: string): boolean {
    const existing = this.getThreadBinding(chatId, threadId);
    if (existing?.projectName) return false; // already bound
    if (existing) {
      // Row exists (creator recorded) — update with project name
      this.db.prepare('UPDATE thread_bindings SET project_name = ? WHERE chat_id = ? AND thread_id = ?')
        .run(projectName, chatId, threadId);
    } else {
      // No row — insert with creator and project
      this.db.prepare('INSERT INTO thread_bindings (chat_id, thread_id, project_name, creator_user_id) VALUES (?, ?, ?, ?)')
        .run(chatId, threadId, projectName, boundBy);
    }
    return true;
  }

  getThreadBinding(chatId: string, threadId: string): { projectName: string | null; creatorUserId: string } | null {
    const row = this.db.prepare('SELECT * FROM thread_bindings WHERE chat_id = ? AND thread_id = ?')
      .get(chatId, threadId) as any;
    if (!row) return null;
    return { projectName: row.project_name, creatorUserId: row.creator_user_id };
  }

  close(): void {
    this.db.close();
  }
}
