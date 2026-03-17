# Feishu x Claude Code Bot Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Feishu bot that connects to Claude Code Agent SDK, enabling a 5-person team to do development work via Feishu messages with interactive card responses.

**Architecture:** Single Node.js/TypeScript service using Feishu SDK WebSocket for message reception, Claude Agent SDK `query()` for streaming code execution, SQLite for session/project persistence, and Feishu interactive cards for rich output.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk`, `@larksuiteoapi/node-sdk`, `better-sqlite3`, `pino`, `dotenv`

**Spec:** `docs/superpowers/specs/2026-03-17-feishu-claude-code-bot-design.md`

---

## Important SDK Notes

The Claude Code Agent SDK package is `@anthropic-ai/claude-agent-sdk` (not `@anthropic-ai/claude-code`). The primary function is `query()`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const conversation = query({
  prompt: "user message",
  options: {
    cwd: "/path/to/project",
    resume: "session-id",           // resume a previous session
    abortController: new AbortController(),
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    permissionMode: "default",
    canUseTool: customPermissionHandler, // intercept dangerous ops → Feishu confirm card
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
  }
});

// conversation is AsyncGenerator<SDKMessage, void>
for await (const message of conversation) {
  // message.type: "assistant" | "user" | "result" | ...
}
```

Key message types for our card updates:
- `SDKAssistantMessage` (type: "assistant") — contains `message.content` array with `text` and `tool_use` blocks
- `SDKResultMessage` (type: "result") — final result with `session_id`
- `SDKToolUseSummaryMessage` (type: "tool_use_summary") — summary of tool calls

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder)

- [ ] **Step 1: Initialize project**

```bash
cd /Users/gyronee/Developer/remote-control
git init
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "remote-control",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@larksuiteoapi/node-sdk": "^1.45.0",
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.4.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create .env.example**

```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx
WORKSPACE_DIR=~/workspaces
ALLOWED_USER_IDS=ou_xxx1,ou_xxx2
ALLOWED_GROUP_IDS=oc_xxx1
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.db
```

- [ ] **Step 6: Create placeholder src/index.ts**

```typescript
import 'dotenv/config';

console.log('remote-control starting...');
```

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

- [ ] **Step 8: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .env.example .gitignore src/index.ts package-lock.json
git commit -m "feat: initial project scaffolding"
```

---

### Task 2: Configuration and Logger

**Files:**
- Create: `src/config.ts`
- Create: `src/logger.ts`
- Create: `src/config.test.ts`

- [ ] **Step 1: Write the failing test for config**

Create `src/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads required config from env', () => {
    process.env.FEISHU_APP_ID = 'test_app_id';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.WORKSPACE_DIR = '/tmp/workspaces';
    process.env.ALLOWED_USER_IDS = 'ou_1,ou_2';
    process.env.ALLOWED_GROUP_IDS = 'oc_1';

    const config = loadConfig();
    expect(config.feishu.appId).toBe('test_app_id');
    expect(config.feishu.appSecret).toBe('test_secret');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.workspaceDir).toBe('/tmp/workspaces');
    expect(config.allowedUserIds).toEqual(['ou_1', 'ou_2']);
    expect(config.allowedGroupIds).toEqual(['oc_1']);
  });

  it('throws if required env vars are missing', () => {
    delete process.env.FEISHU_APP_ID;
    expect(() => loadConfig()).toThrow('FEISHU_APP_ID');
  });

  it('defaults allowedUserIds to empty array when not set', () => {
    process.env.FEISHU_APP_ID = 'id';
    process.env.FEISHU_APP_SECRET = 'secret';
    process.env.ANTHROPIC_API_KEY = 'key';
    process.env.WORKSPACE_DIR = '/tmp/ws';

    const config = loadConfig();
    expect(config.allowedUserIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/config.test.ts
```

Expected: FAIL — `loadConfig` not found.

- [ ] **Step 3: Implement config.ts**

Create `src/config.ts`:

```typescript
export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
  };
  anthropicApiKey: string;
  workspaceDir: string;
  allowedUserIds: string[];
  allowedGroupIds: string[];
  taskTimeoutMs: number;
  debounceMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseList(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    feishu: {
      appId: requireEnv('FEISHU_APP_ID'),
      appSecret: requireEnv('FEISHU_APP_SECRET'),
    },
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    workspaceDir: requireEnv('WORKSPACE_DIR').replace(/^~/, process.env.HOME || ''),
    allowedUserIds: parseList(process.env.ALLOWED_USER_IDS),
    allowedGroupIds: parseList(process.env.ALLOWED_GROUP_IDS),
    taskTimeoutMs: parseInt(process.env.TASK_TIMEOUT_MS || '300000', 10),
    debounceMs: parseInt(process.env.DEBOUNCE_MS || '500', 10),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/config.test.ts
```

Expected: PASS

- [ ] **Step 5: Create logger.ts**

Create `src/logger.ts`:

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/logger.ts
git commit -m "feat: add config loader and logger"
```

---

### Task 3: SQLite Database Layer

**Files:**
- Create: `src/session/db.ts`
- Create: `src/session/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/session/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './db.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/remote-control-test.db';

describe('Database', () => {
  let db: Database;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  describe('users', () => {
    it('upserts and retrieves a user', () => {
      db.upsertUser('ou_123', 'Alice');
      const user = db.getUser('ou_123');
      expect(user).toMatchObject({ feishu_user_id: 'ou_123', name: 'Alice' });
    });

    it('sets active project', () => {
      db.upsertUser('ou_123', 'Alice');
      db.setActiveProject('ou_123', 'my-app');
      const user = db.getUser('ou_123');
      expect(user?.active_project).toBe('my-app');
    });
  });

  describe('sessions', () => {
    it('creates and finds session by user + project', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.id).toBe(id);
    });

    it('finds session by user + topic + project', () => {
      const id = db.createSession('ou_123', 'topic_1', 'my-app');
      const session = db.findSession('ou_123', 'topic_1', 'my-app');
      expect(session?.id).toBe(id);
    });

    it('returns null for non-existent session', () => {
      const session = db.findSession('ou_999', null, 'no-project');
      expect(session).toBeNull();
    });

    it('updates claude session id', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.updateClaudeSessionId(id, 'claude-session-abc');
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.claude_session_id).toBe('claude-session-abc');
    });

    it('resets session by clearing claude_session_id', () => {
      const id = db.createSession('ou_123', null, 'my-app');
      db.updateClaudeSessionId(id, 'claude-session-abc');
      db.resetSession(id);
      const session = db.findSession('ou_123', null, 'my-app');
      expect(session?.claude_session_id).toBeNull();
    });
  });

  describe('task logs', () => {
    it('logs a task', () => {
      const sessionId = db.createSession('ou_123', null, 'my-app');
      db.logTask(sessionId, 'fix the bug', 'done', '["Read","Edit"]', 1234, 'success');
      const logs = db.getTaskLogs(sessionId, 5);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        user_message: 'fix the bug',
        status: 'success',
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/session/db.test.ts
```

Expected: FAIL — `Database` not found.

- [ ] **Step 3: Implement db.ts**

Create `src/session/db.ts`:

```typescript
import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface UserRow {
  feishu_user_id: string;
  name: string | null;
  active_project: string | null;
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
    `);
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

  setActiveProject(feishuUserId: string, projectName: string): void {
    this.db.prepare('UPDATE users SET active_project = ? WHERE feishu_user_id = ?')
      .run(projectName, feishuUserId);
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
    if (topicId) {
      return this.db.prepare(`
        SELECT * FROM sessions
        WHERE feishu_user_id = ? AND topic_id = ? AND project_name = ?
        ORDER BY last_active_at DESC LIMIT 1
      `).get(feishuUserId, topicId, projectName) as SessionRow | null;
    }
    return this.db.prepare(`
      SELECT * FROM sessions
      WHERE feishu_user_id = ? AND topic_id IS NULL AND project_name = ?
      ORDER BY last_active_at DESC LIMIT 1
    `).get(feishuUserId, projectName) as SessionRow | null;
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

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/session/db.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/db.ts src/session/db.test.ts
git commit -m "feat: add SQLite database layer for users, sessions, task logs"
```

---

### Task 4: Command Parser

**Files:**
- Create: `src/utils/command.ts`
- Create: `src/utils/command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/command.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCommand } from './command.js';

describe('parseCommand', () => {
  it('parses /project list', () => {
    expect(parseCommand('/project list')).toEqual({
      type: 'project', action: 'list', args: []
    });
  });

  it('parses /project use my-app', () => {
    expect(parseCommand('/project use my-app')).toEqual({
      type: 'project', action: 'use', args: ['my-app']
    });
  });

  it('parses /project clone with URL', () => {
    expect(parseCommand('/project clone https://github.com/user/repo.git')).toEqual({
      type: 'project', action: 'clone', args: ['https://github.com/user/repo.git']
    });
  });

  it('parses /project create', () => {
    expect(parseCommand('/project create new-service')).toEqual({
      type: 'project', action: 'create', args: ['new-service']
    });
  });

  it('parses /reset', () => {
    expect(parseCommand('/reset')).toEqual({ type: 'reset', action: null, args: [] });
  });

  it('parses /cancel', () => {
    expect(parseCommand('/cancel')).toEqual({ type: 'cancel', action: null, args: [] });
  });

  it('parses /status', () => {
    expect(parseCommand('/status')).toEqual({ type: 'status', action: null, args: [] });
  });

  it('returns null for non-command text', () => {
    expect(parseCommand('help me fix this bug')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCommand('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/utils/command.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement command.ts**

Create `src/utils/command.ts`:

```typescript
export interface ParsedCommand {
  type: 'project' | 'reset' | 'cancel' | 'status';
  action: string | null;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case '/project': {
      const action = parts[1] || null;
      const args = parts.slice(2);
      if (!action) return null;
      return { type: 'project', action, args };
    }
    case '/reset':
      return { type: 'reset', action: null, args: [] };
    case '/cancel':
      return { type: 'cancel', action: null, args: [] };
    case '/status':
      return { type: 'status', action: null, args: [] };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/utils/command.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/command.ts src/utils/command.test.ts
git commit -m "feat: add command parser for /project, /reset, /cancel, /status"
```

---

### Task 5: Project Manager

**Files:**
- Create: `src/project/config.ts`
- Create: `src/project/manager.ts`
- Create: `src/project/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/project/manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectManager } from './manager.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_WORKSPACE = '/tmp/remote-control-test-workspace';

describe('ProjectManager', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    mkdirSync(TEST_WORKSPACE, { recursive: true });
    pm = new ProjectManager(TEST_WORKSPACE);
  });

  afterEach(() => {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns empty list when no projects configured', () => {
      expect(pm.list()).toEqual([]);
    });
  });

  describe('create', () => {
    it('creates a new project with git init', () => {
      pm.create('my-app');
      const projectPath = join(TEST_WORKSPACE, 'projects', 'my-app');
      expect(existsSync(projectPath)).toBe(true);
      expect(existsSync(join(projectPath, '.git'))).toBe(true);
    });

    it('adds created project to config', () => {
      pm.create('my-app');
      const projects = pm.list();
      expect(projects.find(p => p.name === 'my-app')).toBeTruthy();
    });

    it('rejects invalid project names', () => {
      expect(() => pm.create('../evil')).toThrow();
      expect(() => pm.create('foo bar')).toThrow();
    });
  });

  describe('resolve', () => {
    it('resolves path for an existing project', () => {
      pm.create('my-app');
      const path = pm.resolve('my-app');
      expect(path).toBe(join(TEST_WORKSPACE, 'projects', 'my-app'));
    });

    it('throws for non-existent project', () => {
      expect(() => pm.resolve('nope')).toThrow();
    });
  });

  describe('validateCloneUrl', () => {
    it('accepts https URLs', () => {
      expect(() => pm.validateCloneUrl('https://github.com/user/repo.git')).not.toThrow();
    });

    it('rejects non-https URLs', () => {
      expect(() => pm.validateCloneUrl('git://github.com/user/repo.git')).toThrow();
      expect(() => pm.validateCloneUrl('file:///etc/passwd')).toThrow();
      expect(() => pm.validateCloneUrl('ssh://git@github.com/repo')).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/project/manager.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement config.ts**

Create `src/project/config.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProjectEntry {
  path: string;
  description: string;
  defaultBranch?: string;
}

export interface WorkspaceConfig {
  projects: Record<string, ProjectEntry>;
  defaults: {
    tmpCleanupDays: number;
  };
}

const DEFAULT_CONFIG: WorkspaceConfig = {
  projects: {},
  defaults: { tmpCleanupDays: 7 },
};

export function readConfig(workspaceDir: string): WorkspaceConfig {
  const configPath = join(workspaceDir, '.config.json');
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG, projects: {} };
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

export function writeConfig(workspaceDir: string, config: WorkspaceConfig): void {
  const configPath = join(workspaceDir, '.config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: Implement manager.ts**

Create `src/project/manager.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readConfig, writeConfig, type ProjectEntry } from './config.js';
import { logger } from '../logger.js';

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export interface ProjectInfo {
  name: string;
  path: string;
  description: string;
}

export class ProjectManager {
  constructor(private workspaceDir: string) {
    mkdirSync(join(workspaceDir, 'projects'), { recursive: true });
    mkdirSync(join(workspaceDir, 'tmp'), { recursive: true });
  }

  list(): ProjectInfo[] {
    const config = readConfig(this.workspaceDir);
    return Object.entries(config.projects).map(([name, entry]) => ({
      name,
      path: join(this.workspaceDir, entry.path),
      description: entry.description,
    }));
  }

  resolve(name: string): string {
    const config = readConfig(this.workspaceDir);
    const entry = config.projects[name];
    if (!entry) throw new Error(`Project "${name}" not found. Use /project list to see available projects.`);
    const fullPath = join(this.workspaceDir, entry.path);
    if (!existsSync(fullPath)) throw new Error(`Project path does not exist: ${fullPath}`);
    return fullPath;
  }

  create(name: string): string {
    if (!VALID_NAME.test(name)) {
      throw new Error(`Invalid project name "${name}". Only [a-zA-Z0-9_-] allowed.`);
    }
    const projectPath = join(this.workspaceDir, 'projects', name);
    if (existsSync(projectPath)) throw new Error(`Project "${name}" already exists.`);

    mkdirSync(projectPath, { recursive: true });
    execSync('git init', { cwd: projectPath, stdio: 'ignore' });

    const config = readConfig(this.workspaceDir);
    config.projects[name] = {
      path: `projects/${name}`,
      description: '',
      defaultBranch: 'main',
    };
    writeConfig(this.workspaceDir, config);
    logger.info({ name, path: projectPath }, 'Project created');
    return projectPath;
  }

  validateCloneUrl(url: string): void {
    if (!url.startsWith('https://')) {
      throw new Error('Only https:// URLs are allowed for cloning.');
    }
  }

  async clone(url: string): Promise<{ name: string; path: string }> {
    this.validateCloneUrl(url);
    const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const shortId = randomBytes(3).toString('hex');
    const dirName = `${shortId}-${repoName}`;
    const clonePath = join(this.workspaceDir, 'tmp', dirName);

    execSync(`git clone --depth 1 ${url} ${clonePath}`, { stdio: 'ignore', timeout: 120_000 });

    const config = readConfig(this.workspaceDir);
    config.projects[dirName] = {
      path: `tmp/${dirName}`,
      description: `Cloned from ${url}`,
    };
    writeConfig(this.workspaceDir, config);
    logger.info({ name: dirName, url }, 'Repository cloned');
    return { name: dirName, path: clonePath };
  }

  cleanupTmp(): void {
    const config = readConfig(this.workspaceDir);
    const maxAge = (config.defaults?.tmpCleanupDays ?? 7) * 24 * 60 * 60 * 1000;
    const tmpDir = join(this.workspaceDir, 'tmp');
    if (!existsSync(tmpDir)) return;

    const entries = readdirSync(tmpDir);
    const now = Date.now();

    for (const entry of entries) {
      const entryPath = join(tmpDir, entry);
      try {
        const stat = statSync(entryPath);
        if (now - stat.mtimeMs > maxAge) {
          rmSync(entryPath, { recursive: true, force: true });
          // Also remove from config
          const name = entry;
          if (config.projects[name]) {
            delete config.projects[name];
          }
          logger.info({ path: entryPath }, 'Cleaned up old tmp project');
        }
      } catch {
        // skip
      }
    }
    writeConfig(this.workspaceDir, config);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/project/manager.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/project/config.ts src/project/manager.ts src/project/manager.test.ts
git commit -m "feat: add project manager with create, clone, list, resolve"
```

---

### Task 6: Session Manager

**Files:**
- Create: `src/session/manager.ts`
- Create: `src/session/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/session/manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './manager.js';
import { Database } from './db.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/remote-control-session-test.db';

describe('SessionManager', () => {
  let db: Database;
  let sm: SessionManager;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
    sm = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('creates a new session when none exists', () => {
    const session = sm.getOrCreate('ou_1', null, 'my-app');
    expect(session.id).toBeTruthy();
    expect(session.claude_session_id).toBeNull();
  });

  it('reuses existing session', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'my-app');
    const s2 = sm.getOrCreate('ou_1', null, 'my-app');
    expect(s1.id).toBe(s2.id);
  });

  it('separates sessions by topic', () => {
    const s1 = sm.getOrCreate('ou_1', 'topic_a', 'my-app');
    const s2 = sm.getOrCreate('ou_1', 'topic_b', 'my-app');
    expect(s1.id).not.toBe(s2.id);
  });

  it('separates sessions by project', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'app-a');
    const s2 = sm.getOrCreate('ou_1', null, 'app-b');
    expect(s1.id).not.toBe(s2.id);
  });

  it('resets a session', () => {
    const s1 = sm.getOrCreate('ou_1', null, 'my-app');
    db.updateClaudeSessionId(s1.id, 'claude-abc');
    sm.reset('ou_1', null, 'my-app');
    const s2 = sm.getOrCreate('ou_1', null, 'my-app');
    expect(s2.claude_session_id).toBeNull();
  });

  describe('active tasks', () => {
    it('tracks active task per user', () => {
      expect(sm.hasActiveTask('ou_1')).toBe(false);
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      expect(sm.hasActiveTask('ou_1')).toBe(true);
    });

    it('cancels active task', () => {
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      sm.cancelTask('ou_1');
      expect(controller.signal.aborted).toBe(true);
      expect(sm.hasActiveTask('ou_1')).toBe(false);
    });

    it('clears active task', () => {
      const controller = new AbortController();
      sm.setActiveTask('ou_1', controller);
      sm.clearActiveTask('ou_1');
      expect(sm.hasActiveTask('ou_1')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/session/manager.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement manager.ts**

Create `src/session/manager.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/session/manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/manager.ts src/session/manager.test.ts
git commit -m "feat: add session manager with active task tracking"
```

---

### Task 7: Feishu Card Builder

**Files:**
- Create: `src/feishu/cards.ts`
- Create: `src/feishu/cards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/feishu/cards.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CardBuilder, sanitizeMarkdown } from './cards.js';

describe('CardBuilder', () => {
  it('builds a thinking card', () => {
    const card = CardBuilder.thinking('my-app');
    expect(card).toHaveProperty('header');
    expect(card.header.title.content).toContain('my-app');
  });

  it('builds a working card with text and tool status', () => {
    const card = CardBuilder.working('my-app', 'Analyzing code...', [
      { tool: 'Read', status: 'done', detail: 'src/index.ts' },
      { tool: 'Edit', status: 'running', detail: 'src/utils.ts' },
    ]);
    const json = JSON.stringify(card);
    expect(json).toContain('Analyzing code...');
    expect(json).toContain('src/index.ts');
  });

  it('builds a done card', () => {
    const card = CardBuilder.done('my-app', 'Here is the result', 3);
    const json = JSON.stringify(card);
    expect(json).toContain('Here is the result');
  });

  it('builds an error card', () => {
    const card = CardBuilder.error('my-app', 'Something went wrong');
    const json = JSON.stringify(card);
    expect(json).toContain('Something went wrong');
  });

  it('builds a confirm card', () => {
    const card = CardBuilder.confirm('my-app', 'git push origin main', 'task-123');
    const json = JSON.stringify(card);
    expect(json).toContain('git push origin main');
  });
});

describe('sanitizeMarkdown', () => {
  it('passes through simple markdown', () => {
    expect(sanitizeMarkdown('Hello **world**')).toBe('Hello **world**');
  });

  it('truncates very long content', () => {
    const long = 'a'.repeat(5000);
    const result = sanitizeMarkdown(long, 2000);
    expect(result.length).toBeLessThanOrEqual(2100); // allow for suffix
    expect(result).toContain('...');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/feishu/cards.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement cards.ts**

Create `src/feishu/cards.ts`:

```typescript
export interface ToolStatus {
  tool: string;
  status: 'running' | 'done';
  detail: string;
}

interface FeishuCard {
  header: {
    title: { tag: string; content: string };
    template: string;
  };
  elements: unknown[];
}

export function sanitizeMarkdown(text: string, maxLength = 3000): string {
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + '\n\n... (content truncated)';
  }
  return text;
}

function toolStatusText(tools: ToolStatus[]): string {
  return tools
    .map(t => t.status === 'done' ? `✓ ${t.tool}: ${t.detail}` : `⟳ ${t.tool}: ${t.detail}`)
    .join('\n');
}

export const CardBuilder = {
  thinking(project: string): FeishuCard {
    return {
      header: {
        title: { tag: 'plain_text', content: `⏳ Thinking · ${project}` },
        template: 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Processing your request...' } },
      ],
    };
  },

  working(project: string, text: string, tools: ToolStatus[]): FeishuCard {
    const elements: unknown[] = [];
    if (text) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: sanitizeMarkdown(text) },
      });
    }
    if (tools.length > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: toolStatusText(tools) },
      });
    }
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: 'Cancel' },
        type: 'danger',
        value: { action: 'cancel_task' },
      }],
    });
    return {
      header: {
        title: { tag: 'plain_text', content: `🔧 Working · ${project}` },
        template: 'orange',
      },
      elements,
    };
  },

  done(project: string, text: string, toolCount: number): FeishuCard {
    const elements: unknown[] = [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: sanitizeMarkdown(text) },
      },
    ];
    if (toolCount > 0) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: `Tool calls: ${toolCount}` },
      });
    }
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Reset Session' },
          type: 'default',
          value: { action: 'reset_session' },
        },
      ],
    });
    return {
      header: {
        title: { tag: 'plain_text', content: `✓ Done · ${project}` },
        template: 'green',
      },
      elements,
    };
  },

  error(project: string, errorMessage: string): FeishuCard {
    return {
      header: {
        title: { tag: 'plain_text', content: `✗ Error · ${project}` },
        template: 'red',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: sanitizeMarkdown(errorMessage) },
        },
      ],
    };
  },

  confirm(project: string, command: string, taskId: string): FeishuCard {
    return {
      header: {
        title: { tag: 'plain_text', content: `⚠️ Confirm · ${project}` },
        template: 'yellow',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `Claude wants to execute:\n\`\`\`\n${command}\n\`\`\`` },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Allow' },
              type: 'primary',
              value: { action: 'confirm_danger', taskId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Deny' },
              type: 'danger',
              value: { action: 'reject_danger', taskId },
            },
          ],
        },
      ],
    };
  },

  cancelled(project: string): FeishuCard {
    return {
      header: {
        title: { tag: 'plain_text', content: `⊘ Cancelled · ${project}` },
        template: 'grey',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: 'Task was cancelled.' } },
      ],
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/feishu/cards.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishu/cards.ts src/feishu/cards.test.ts
git commit -m "feat: add Feishu interactive card builder"
```

---

### Task 8: Claude Code Executor with Streaming

**Files:**
- Create: `src/claude/executor.ts`
- Create: `src/claude/stream.ts`

- [ ] **Step 1: Create stream.ts — debounced card updater**

Create `src/claude/stream.ts`:

```typescript
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
      // Rate limited — back off
      if (err?.response?.status === 429 || err?.code === 429) {
        this.currentDelayMs = Math.min(this.currentDelayMs * 2, 5000);
      }
      // Re-schedule the pending content
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
```

- [ ] **Step 2: Create executor.ts — Claude Agent SDK wrapper**

Create `src/claude/executor.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';
import { type ToolStatus } from '../feishu/cards.js';

export interface ExecutionCallbacks {
  onText: (fullText: string) => void;
  onToolStart: (tool: string, detail: string) => void;
  onToolEnd: (tool: string, detail: string) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: string) => void;
  onPermissionRequest: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
}

export interface ExecutionResult {
  text: string;
  sessionId: string;
  toolCount: number;
  durationMs: number;
}

export async function executeClaudeTask(
  prompt: string,
  cwd: string,
  resumeSessionId: string | null,
  abortController: AbortController,
  callbacks: ExecutionCallbacks,
): Promise<void> {
  const startTime = Date.now();
  let fullText = '';
  let toolCount = 0;
  let sessionId = '';

  try {
    const conversation = query({
      prompt,
      options: {
        cwd,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        abortController,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        permissionMode: 'default',
        canUseTool: async (toolName, input) => {
          // Auto-approve safe tools (Bash goes through permission flow)
          const safeTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];
          if (safeTools.includes(toolName)) {
            return { behavior: 'allow' as const };
          }
          // For Bash and other tools, ask user via Feishu confirm card
          const allowed = await callbacks.onPermissionRequest(toolName, input);
          if (allowed) {
            return { behavior: 'allow' as const };
          }
          return { behavior: 'deny' as const, message: 'User denied the operation' };
        },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
      },
    });

    for await (const message of conversation) {
      if (abortController.signal.aborted) break;

      switch (message.type) {
        case 'assistant': {
          // Extract text content from the assistant message
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                fullText += block.text;
                callbacks.onText(fullText);
              } else if (block.type === 'tool_use') {
                toolCount++;
                const input = block.input as Record<string, unknown> | undefined;
                const detail = input?.command ?? input?.file_path ?? input?.pattern ?? block.name;
                callbacks.onToolStart(block.name, String(detail));
              } else if (block.type === 'tool_result') {
                callbacks.onToolEnd(block.name || 'tool', 'completed');
              }
            }
          }
          break;
        }
        case 'result': {
          sessionId = message.session_id;
          if (message.subtype === 'success') {
            // Extract final text from result
            const resultText = fullText || (typeof message.result === 'string' ? message.result : '');
            callbacks.onComplete({
              text: resultText,
              sessionId,
              toolCount,
              durationMs: Date.now() - startTime,
            });
          } else {
            callbacks.onError(message.error || 'Unknown error');
          }
          return;
        }
        default:
          logger.debug({ type: message.type }, 'Unhandled SDK message type');
      }
    }

    // If loop ends without result message
    callbacks.onComplete({
      text: fullText || 'Task completed.',
      sessionId,
      toolCount,
      durationMs: Date.now() - startTime,
    });
  } catch (err: any) {
    if (abortController.signal.aborted) {
      return; // Cancelled, don't report as error
    }
    logger.error({ err }, 'Claude execution failed');
    callbacks.onError(err.message || 'Claude Code execution failed');
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/claude/executor.ts src/claude/stream.ts
git commit -m "feat: add Claude Agent SDK executor with streaming and debounced updater"
```

---

### Task 9: Feishu Client and Message Handler

**Files:**
- Create: `src/feishu/client.ts`
- Create: `src/feishu/handler.ts`
- Create: `src/feishu/actions.ts`

- [ ] **Step 1: Create client.ts — Feishu SDK init and card helpers**

Create `src/feishu/client.ts`:

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

export class FeishuClient {
  public client: Lark.Client;
  public wsClient: Lark.WSClient;

  constructor(private config: Config) {
    const baseConfig = {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  async sendCard(chatId: string, card: object): Promise<string | null> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: 'interactive' as any,
        },
      });
      return resp?.data?.message_id || null;
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send card');
      return null;
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      logger.warn({ err, messageId }, 'Failed to update card');
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text' as any,
        },
      });
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send text');
    }
  }

  start(eventDispatcher: Lark.EventDispatcher, cardHandler?: Lark.CardActionHandler): void {
    this.wsClient.start({
      eventDispatcher,
      ...(cardHandler ? { cardActionHandler: cardHandler } : {}),
    });
    logger.info('Feishu WebSocket client started');
  }
}
```

- [ ] **Step 2: Create handler.ts — message routing**

Create `src/feishu/handler.ts`:

```typescript
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { FeishuClient } from './client.js';
import { SessionManager } from '../session/manager.js';
import { Database } from '../session/db.js';
import { ProjectManager } from '../project/manager.js';
import { CardBuilder, type ToolStatus } from './cards.js';
import { DebouncedUpdater } from '../claude/stream.js';
import { executeClaudeTask, type ExecutionResult } from '../claude/executor.js';
import { parseCommand, type ParsedCommand } from '../utils/command.js';
import { handleCardAction, type CardAction } from './actions.js';
import { logger } from '../logger.js';

// Pending permission requests: taskKey → resolve function
const pendingPermissions = new Map<string, (allowed: boolean) => void>();

export class MessageHandler {
  constructor(
    private config: Config,
    private feishu: FeishuClient,
    private sessionManager: SessionManager,
    private projectManager: ProjectManager,
    private db: Database,
  ) {}

  createEventDispatcher(): Lark.EventDispatcher {
    return new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleMessage(data);
        } catch (err) {
          logger.error({ err }, 'Unhandled error in message handler');
        }
      },
    });
  }

  createCardActionHandler(): Lark.CardActionHandler {
    return new Lark.CardActionHandler(
      {},
      async (data: any) => {
        const userId = data?.operator?.user_id;
        const actionValue = data?.action?.value as CardAction | undefined;
        if (!userId || !actionValue) return;

        // Handle permission confirm/deny
        if (actionValue.action === 'confirm_danger' || actionValue.action === 'reject_danger') {
          const taskId = actionValue.taskId;
          if (taskId) {
            const resolve = pendingPermissions.get(taskId);
            if (resolve) {
              resolve(actionValue.action === 'confirm_danger');
              pendingPermissions.delete(taskId);
            }
          }
          return;
        }

        handleCardAction(actionValue, userId, this.sessionManager, this.db);
      },
    );
  }

  // Helper for permission request flow
  requestPermission(taskId: string): Promise<boolean> {
    return new Promise((resolve) => {
      pendingPermissions.set(taskId, resolve);
      // Auto-deny after 60s if no response
      setTimeout(() => {
        if (pendingPermissions.has(taskId)) {
          pendingPermissions.delete(taskId);
          resolve(false);
        }
      }, 60_000);
    });
  }

  private async handleMessage(data: any): Promise<void> {
    const { message, sender } = data;
    const userId = sender?.sender_id?.user_id;
    const chatId = message?.chat_id;
    const msgType = message?.message_type;
    const content = message?.content ? JSON.parse(message.content) : {};
    const text = content?.text?.replace(/@_user_\d+/g, '').trim() || '';
    const topicId = message?.root_id || null;

    if (!userId || !chatId) return;

    // Auth check: user allowlist
    if (this.config.allowedUserIds.length > 0 && !this.config.allowedUserIds.includes(userId)) {
      logger.warn({ userId }, 'Unauthorized user');
      return;
    }

    // Auth check: group allowlist (for group chats)
    const chatType = message?.chat_type;
    if (chatType === 'group' && this.config.allowedGroupIds.length > 0
        && !this.config.allowedGroupIds.includes(chatId)) {
      logger.warn({ chatId }, 'Unauthorized group');
      return;
    }

    // Only handle text messages
    if (msgType !== 'text') {
      await this.feishu.sendText(chatId, 'Currently only text messages are supported.');
      return;
    }

    // Ensure user exists
    this.db.upsertUser(userId, sender?.sender_id?.id || null);

    // Try parsing as command
    const cmd = parseCommand(text);
    if (cmd) {
      await this.handleCommand(cmd, userId, chatId, topicId);
      return;
    }

    // Regular message → send to Claude
    await this.handleClaudeMessage(text, userId, chatId, topicId);
  }

  private async handleCommand(cmd: ParsedCommand, userId: string, chatId: string, topicId: string | null): Promise<void> {
    switch (cmd.type) {
      case 'project': {
        await this.handleProjectCommand(cmd, userId, chatId);
        break;
      }
      case 'reset': {
        const user = this.db.getUser(userId);
        const project = user?.active_project;
        if (!project) {
          await this.feishu.sendText(chatId, 'No active project. Use /project use <name> first.');
          return;
        }
        this.sessionManager.reset(userId, topicId, project);
        await this.feishu.sendText(chatId, 'Session reset.');
        break;
      }
      case 'cancel': {
        if (this.sessionManager.hasActiveTask(userId)) {
          this.sessionManager.cancelTask(userId);
          await this.feishu.sendText(chatId, 'Task cancelled.');
        } else {
          await this.feishu.sendText(chatId, 'No active task to cancel.');
        }
        break;
      }
      case 'status': {
        const user = this.db.getUser(userId);
        const hasTask = this.sessionManager.hasActiveTask(userId);
        const lines = [
          `Project: ${user?.active_project || '(none)'}`,
          `Task running: ${hasTask ? 'yes' : 'no'}`,
        ];
        await this.feishu.sendText(chatId, lines.join('\n'));
        break;
      }
    }
  }

  private async handleProjectCommand(cmd: ParsedCommand, userId: string, chatId: string): Promise<void> {
    switch (cmd.action) {
      case 'list': {
        const projects = this.projectManager.list();
        if (projects.length === 0) {
          await this.feishu.sendText(chatId, 'No projects configured. Use /project create <name> or /project clone <url>.');
          return;
        }
        const list = projects.map(p => `• ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n');
        await this.feishu.sendText(chatId, list);
        break;
      }
      case 'use': {
        const name = cmd.args[0];
        if (!name) { await this.feishu.sendText(chatId, 'Usage: /project use <name>'); return; }
        try {
          this.projectManager.resolve(name);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Switched to project: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      case 'create': {
        const name = cmd.args[0];
        if (!name) { await this.feishu.sendText(chatId, 'Usage: /project create <name>'); return; }
        try {
          this.projectManager.create(name);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Project created: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      case 'clone': {
        const url = cmd.args[0];
        if (!url) { await this.feishu.sendText(chatId, 'Usage: /project clone <https://url>'); return; }
        try {
          await this.feishu.sendText(chatId, `Cloning ${url}...`);
          const { name } = await this.projectManager.clone(url);
          this.db.setActiveProject(userId, name);
          await this.feishu.sendText(chatId, `Cloned and switched to: ${name}`);
        } catch (err: any) {
          await this.feishu.sendText(chatId, err.message);
        }
        break;
      }
      default:
        await this.feishu.sendText(chatId, `Unknown project command: ${cmd.action}`);
    }
  }

  private async handleClaudeMessage(text: string, userId: string, chatId: string, topicId: string | null): Promise<void> {
    const user = this.db.getUser(userId);
    const projectName = user?.active_project;
    if (!projectName) {
      await this.feishu.sendText(chatId, 'No active project. Use /project use <name>, /project create <name>, or /project clone <url> first.');
      return;
    }

    // Concurrency check
    if (this.sessionManager.hasActiveTask(userId)) {
      await this.feishu.sendText(chatId, 'Your previous task is still running. Wait for it to finish or send /cancel.');
      return;
    }

    let projectPath: string;
    try {
      projectPath = this.projectManager.resolve(projectName);
    } catch (err: any) {
      await this.feishu.sendText(chatId, err.message);
      return;
    }

    const session = this.sessionManager.getOrCreate(userId, topicId, projectName);

    // Send thinking card
    const thinkingCard = CardBuilder.thinking(projectName);
    const messageId = await this.feishu.sendCard(chatId, thinkingCard);
    if (!messageId) return;

    // Set up execution
    const abortController = new AbortController();
    this.sessionManager.setActiveTask(userId, abortController);

    // Timeout
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.config.taskTimeoutMs);

    const tools: ToolStatus[] = [];
    const startTime = Date.now();

    const updater = new DebouncedUpdater(async (content: string) => {
      const card = CardBuilder.working(projectName, content, tools);
      await this.feishu.updateCard(messageId, card);
    }, this.config.debounceMs);

    await executeClaudeTask(
      text,
      projectPath,
      session.claude_session_id,
      abortController,
      {
        onText: (fullText) => {
          updater.schedule(fullText);
        },
        onToolStart: (tool, detail) => {
          tools.push({ tool, status: 'running', detail });
          const card = CardBuilder.working(projectName, '', tools);
          this.feishu.updateCard(messageId, card).catch(() => {});
        },
        onToolEnd: (tool, _detail) => {
          // Match by tool name, fall back to first running
          const match = tools.find(t => t.tool === tool && t.status === 'running')
            || tools.find(t => t.status === 'running');
          if (match) match.status = 'done';
        },
        onPermissionRequest: async (toolName, input) => {
          // Show confirm card and wait for user response
          const taskId = `perm-${Date.now()}`;
          const command = toolName === 'Bash'
            ? String((input as any).command || toolName)
            : `${toolName}(${JSON.stringify(input).slice(0, 100)})`;
          const confirmCard = CardBuilder.confirm(projectName, command, taskId);
          await this.feishu.sendCard(chatId, confirmCard);
          return this.requestPermission(taskId);
        },
        onComplete: async (result: ExecutionResult) => {
          clearTimeout(timeout);
          await updater.flush();
          updater.destroy();
          this.sessionManager.clearActiveTask(userId);

          // Save session ID for resume
          if (result.sessionId) {
            this.db.updateClaudeSessionId(session.id, result.sessionId);
          }

          // Log task
          this.db.logTask(session.id, text, result.text, JSON.stringify(tools.map(t => t.tool)), result.durationMs, 'success');

          // Final card
          const card = CardBuilder.done(projectName, result.text, result.toolCount);
          await this.feishu.updateCard(messageId, card);
        },
        onError: async (error) => {
          clearTimeout(timeout);
          updater.destroy();
          this.sessionManager.clearActiveTask(userId);
          const durationMs = Date.now() - startTime;
          this.db.logTask(session.id, text, error, null, durationMs, 'error');

          if (abortController.signal.aborted) {
            const card = CardBuilder.cancelled(projectName);
            await this.feishu.updateCard(messageId, card);
          } else {
            const card = CardBuilder.error(projectName, error);
            await this.feishu.updateCard(messageId, card);
          }
        },
      },
    );
  }
}
```

- [ ] **Step 3: Create actions.ts — card button event handler**

Create `src/feishu/actions.ts`:

```typescript
import type { SessionManager } from '../session/manager.js';
import { logger } from '../logger.js';

export interface CardAction {
  action: string;
  taskId?: string;
}

export function handleCardAction(
  actionValue: CardAction,
  userId: string,
  sessionManager: SessionManager,
  db?: import('../session/db.js').Database,
): void {
  switch (actionValue.action) {
    case 'cancel_task': {
      sessionManager.cancelTask(userId);
      logger.info({ userId }, 'Task cancelled via card button');
      break;
    }
    case 'reset_session': {
      if (db) {
        const user = db.getUser(userId);
        if (user?.active_project) {
          sessionManager.reset(userId, null, user.active_project);
          logger.info({ userId, project: user.active_project }, 'Session reset via card button');
        }
      }
      break;
    }
    case 'confirm_danger':
    case 'reject_danger': {
      // Handled in handler.ts via pendingPermissions map
      logger.info({ userId, action: actionValue.action }, 'Danger action received');
      break;
    }
    default:
      logger.warn({ action: actionValue.action }, 'Unknown card action');
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/feishu/client.ts src/feishu/handler.ts src/feishu/actions.ts
git commit -m "feat: add Feishu client, message handler, and card action handler"
```

---

### Task 10: Application Entry Point and Graceful Shutdown

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement the main entry point**

Rewrite `src/index.ts`:

```typescript
import 'dotenv/config';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { FeishuClient } from './feishu/client.js';
import { MessageHandler } from './feishu/handler.js';
import { join } from 'path';

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ workspaceDir: config.workspaceDir }, 'Starting remote-control');

  // Initialize database
  const dbPath = join(config.workspaceDir, 'remote-control.db');
  const db = new Database(dbPath);

  // Initialize managers
  const sessionManager = new SessionManager(db);
  const projectManager = new ProjectManager(config.workspaceDir);

  // Cleanup old tmp projects on startup
  projectManager.cleanupTmp();

  // Initialize Feishu client
  const feishu = new FeishuClient(config);
  const handler = new MessageHandler(config, feishu, sessionManager, projectManager, db);

  // Start WebSocket connection with message events and card action events
  const dispatcher = handler.createEventDispatcher();
  const cardHandler = handler.createCardActionHandler();
  feishu.start(dispatcher, cardHandler);

  logger.info('remote-control is ready');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    sessionManager.cancelAll();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors (may need to fix import issues)

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add main entry point with graceful shutdown"
```

---

### Task 11: Integration Test and Manual Verification

**Files:**
- Create: `src/integration.test.ts`

- [ ] **Step 1: Write a lightweight integration test**

Create `src/integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './session/db.js';
import { SessionManager } from './session/manager.js';
import { ProjectManager } from './project/manager.js';
import { parseCommand } from './utils/command.js';
import { CardBuilder } from './feishu/cards.js';
import { existsSync, unlinkSync, rmSync } from 'fs';

const TEST_DB = '/tmp/remote-control-integration.db';
const TEST_WORKSPACE = '/tmp/remote-control-integration-workspace';

describe('Integration: end-to-end flow (without Feishu/Claude)', () => {
  let db: Database;
  let sm: SessionManager;
  let pm: ProjectManager;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    db = new Database(TEST_DB);
    sm = new SessionManager(db);
    pm = new ProjectManager(TEST_WORKSPACE);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  });

  it('full flow: create project → get session → build cards', () => {
    // 1. Create project
    pm.create('test-app');
    const projects = pm.list();
    expect(projects).toHaveLength(1);

    // 2. Set active project
    db.upsertUser('ou_1', 'Alice');
    db.setActiveProject('ou_1', 'test-app');

    // 3. Get session
    const session = sm.getOrCreate('ou_1', null, 'test-app');
    expect(session.id).toBeTruthy();

    // 4. Build thinking card
    const thinking = CardBuilder.thinking('test-app');
    expect(thinking.header.template).toBe('blue');

    // 5. Build working card
    const working = CardBuilder.working('test-app', 'Analyzing...', [
      { tool: 'Read', status: 'done', detail: 'src/index.ts' },
    ]);
    expect(working.header.template).toBe('orange');

    // 6. Build done card
    const done = CardBuilder.done('test-app', 'All done!', 1);
    expect(done.header.template).toBe('green');

    // 7. Simulate session update
    db.updateClaudeSessionId(session.id, 'claude-session-xyz');
    const updated = sm.getOrCreate('ou_1', null, 'test-app');
    expect(updated.claude_session_id).toBe('claude-session-xyz');

    // 8. Task log
    db.logTask(session.id, 'fix bug', 'fixed', '["Read","Edit"]', 5000, 'success');
    const logs = db.getTaskLogs(session.id, 10);
    expect(logs).toHaveLength(1);
  });

  it('command parsing integrates with project manager', () => {
    const cmd = parseCommand('/project create new-service');
    expect(cmd).toEqual({ type: 'project', action: 'create', args: ['new-service'] });

    pm.create('new-service');
    const path = pm.resolve('new-service');
    expect(existsSync(path)).toBe(true);
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: add integration test for end-to-end flow"
```

---

### Task 12: Documentation and .env.example

**Files:**
- Modify: `.env.example` (already created)

- [ ] **Step 1: Run full test suite one final time**

```bash
npx vitest run
```

Expected: All PASS

- [ ] **Step 2: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: finalize project structure"
```

---

## Post-Implementation Notes

### To run locally:

1. Create a Feishu app at open.feishu.cn, enable bot capability
2. Subscribe to `im.message.receive_v1` event
3. Enable WebSocket mode in the app's event configuration
4. Copy `.env.example` to `.env` and fill in credentials
5. Run `npm run dev`
6. Message the bot in Feishu

### Future iterations:

- Docker containerization for production deployment
- Rate limiting per user
- Session resume failure auto-recovery (detect stale session, clear and retry)
- `allowedHosts` config for clone URL validation
- File size limits for clone operations
