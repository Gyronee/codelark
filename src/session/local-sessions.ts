import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface LocalSession {
  sessionId: string;
  cwd: string;
  projectName: string;
  summary: string;
  lastModified: number;
  isActive: boolean;
  activePid?: number;
}

export interface RecentMessage {
  role: 'user' | 'assistant';
  text: string;
}

// Configurable base directory for testing
let claudeDir = path.join(os.homedir(), '.claude');

export function setClaudeDir(dir: string): void {
  claudeDir = dir;
}

export function getClaudeDir(): string {
  return claudeDir;
}

// UUID pattern: 8-4-4-4-12 hex chars
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the last N bytes of a file. Returns array of complete lines
 * (first line discarded as it may be truncated).
 */
function readTail(filePath: string, bytes: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const readBytes = Math.min(bytes, size);
    const offset = size - readBytes;
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, offset);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    // If we didn't read from the start, discard first line (may be truncated)
    if (offset > 0 && lines.length > 0) {
      lines.shift();
    }
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Extract cwd from JSONL tail lines.
 */
function extractCwdFromTail(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.cwd && typeof obj.cwd === 'string') {
        return obj.cwd;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/**
 * Extract sessionId from JSONL tail lines.
 */
function extractSessionIdFromTail(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId && typeof obj.sessionId === 'string') {
        return obj.sessionId;
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

/**
 * Extract a summary from the last user message in the tail lines.
 */
function extractSummary(lines: string[], sessionId: string): string {
  let lastUserText = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.isSidechain) continue;
      if (obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        const text = extractTextFromContent(content);
        if (text) lastUserText = text;
      }
    } catch {
      // skip
    }
  }
  if (lastUserText) {
    return lastUserText.length > 80 ? lastUserText.slice(0, 80) + '...' : lastUserText;
  }
  return sessionId.slice(0, 8);
}

/**
 * Extract text from message content (string or ContentBlock array).
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
      }
    }
  }
  return '';
}

/**
 * Load active sessions from ~/.claude/sessions/*.json.
 * Returns a Map of sessionId -> { active, pid }.
 */
function loadActiveSessions(): Map<string, { active: boolean; pid: number }> {
  const result = new Map<string, { active: boolean; pid: number }>();
  const sessionsDir = path.join(claudeDir, 'sessions');
  try {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
        const data = JSON.parse(content);
        if (data.sessionId && data.pid) {
          let alive = false;
          try {
            process.kill(data.pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
          result.set(data.sessionId, { active: alive, pid: data.pid });
        }
      } catch {
        // skip malformed session files
      }
    }
  } catch {
    // sessions dir may not exist
  }
  return result;
}

/**
 * List local Claude Code sessions by scanning JSONL files.
 */
export function listLocalSessions(limit = 15): LocalSession[] {
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return [];
  } catch {
    return [];
  }

  const activeSessions = loadActiveSessions();
  const sessions: LocalSession[] = [];

  try {
    const projectDirs = fs.readdirSync(projectsDir);
    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(projPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let files: string[];
      try {
        files = fs.readdirSync(projPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const baseName = file.replace('.jsonl', '');
        if (!UUID_PATTERN.test(baseName)) continue;

        const filePath = path.join(projPath, file);
        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(filePath);
        } catch {
          continue;
        }

        try {
          const lines = readTail(filePath, 8192);
          if (lines.length === 0) continue;

          const cwd = extractCwdFromTail(lines);
          if (!cwd) continue;

          const sessionId = extractSessionIdFromTail(lines) || baseName;
          const summary = extractSummary(lines, sessionId);
          const activeInfo = activeSessions.get(sessionId);

          sessions.push({
            sessionId,
            cwd,
            projectName: path.basename(cwd),
            summary,
            lastModified: fileStat.mtimeMs,
            isActive: activeInfo?.active ?? false,
            activePid: activeInfo?.active ? activeInfo.pid : undefined,
          });
        } catch {
          continue;
        }
      }
    }
  } catch {
    return [];
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions.slice(0, limit);
}

/**
 * Find a session by ID prefix match.
 */
export function findSessionById(idPrefix: string): LocalSession | null {
  const sessions = listLocalSessions(100);
  return sessions.find(s => s.sessionId.startsWith(idPrefix)) ?? null;
}

/**
 * Get recent messages from a session's JSONL file.
 */
export function getRecentMessages(sessionId: string, count = 5): RecentMessage[] {
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return [];
  } catch {
    return [];
  }

  // Find the JSONL file for this sessionId
  const filePath = findJsonlForSession(sessionId);
  if (!filePath) return [];

  const lines = readTail(filePath, 32768);
  const messages: RecentMessage[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.isSidechain) continue;

      if (obj.type === 'user' && obj.message?.role === 'user') {
        const text = extractTextFromContent(obj.message.content);
        if (text) {
          // Skip tool_result content blocks (they appear as type=user too)
          const content = obj.message.content;
          if (Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result') {
            continue;
          }
          messages.push({
            role: 'user',
            text: text.length > 200 ? text.slice(0, 200) + '...' : text,
          });
        }
      } else if (obj.message?.role === 'assistant') {
        const text = extractTextFromContent(obj.message.content);
        if (text) {
          messages.push({
            role: 'assistant',
            text: text.length > 200 ? text.slice(0, 200) + '...' : text,
          });
        }
      }
    } catch {
      // skip
    }
  }

  return messages.slice(-count);
}

/**
 * Find the JSONL file path for a given sessionId.
 */
function findJsonlForSession(sessionId: string): string | null {
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    const projectDirs = fs.readdirSync(projectsDir);
    for (const projDir of projectDirs) {
      const projPath = path.join(projectsDir, projDir);
      try {
        if (!fs.statSync(projPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Try direct filename match first
      const directPath = path.join(projPath, `${sessionId}.jsonl`);
      if (fs.existsSync(directPath)) return directPath;

      // Otherwise scan files
      try {
        const files = fs.readdirSync(projPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(projPath, file);
          // Check if session ID matches by reading tail
          const lines = readTail(filePath, 4096);
          const sid = extractSessionIdFromTail(lines);
          if (sid === sessionId) return filePath;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
