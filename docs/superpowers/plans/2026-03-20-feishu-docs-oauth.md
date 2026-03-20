# Feishu Docs + User OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude to read/write users' Feishu documents via MCP tools, with OAuth Device Flow for user authorization.

**Architecture:** Three MCP tools (create/fetch/update doc) are registered as an in-process SDK MCP server via `createSdkMcpServer`. Tools call the Feishu official MCP endpoint (`https://mcp.feishu.cn/mcp`) with the user's OAuth access token. OAuth uses Device Flow (RFC 8628): bot sends auth card → user authorizes in browser → bot polls for token → stores in SQLite. Token auto-refresh is handled transparently.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (MCP server), `@larksuiteoapi/node-sdk`, Feishu OAuth 2.0 Device Flow, SQLite (`better-sqlite3`), `zod` (tool schemas)

**Reference:** Official OpenClaw Lark plugin at `/tmp/openclaw-lark-latest/extracted/package/` — especially `src/core/device-flow.js` (OAuth), `src/core/uat-client.js` (token refresh), `src/tools/mcp/shared.js` (MCP calling), `src/tools/mcp/doc/` (tool schemas).

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/auth/device-flow.ts` | OAuth Device Flow: request device authorization, poll for token |
| `src/auth/token-store.ts` | SQLite CRUD for per-user OAuth tokens, auto-refresh logic |
| `src/auth/oauth-card.ts` | Build OAuth authorization cards, success/failure/expired cards |
| `src/tools/feishu-mcp.ts` | Feishu MCP endpoint caller (JSON-RPC 2.0), shared by all doc tools |
| `src/tools/feishu-doc-server.ts` | In-process MCP server with 3 doc tools, registered via `createSdkMcpServer` |
| Modify: `src/session/db.ts` | Add `oauth_tokens` table |
| Modify: `src/claude/executor.ts` | Accept userId + db, inject MCP server into `query()` options |
| Modify: `src/messaging/inbound/dispatch.ts` | Pass userId + db to executor |
| Modify: `src/config.ts` | (No change needed — appId/appSecret reused from existing feishu config) |

---

### Task 1: Add oauth_tokens table to SQLite

**Files:**
- Modify: `src/session/db.ts`
- Test: `src/session/db.test.ts`

- [ ] **Step 1: Write tests for token CRUD**

Test cases:
1. `saveToken(userId, token)` → stores token
2. `getToken(userId)` → returns stored token with all fields
3. `getToken(userId)` → returns null when no token
4. `deleteToken(userId)` → removes token
5. `saveToken` twice → upserts (replaces old token)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/db.test.ts`

- [ ] **Step 3: Add oauth_tokens table and methods**

In `db.ts` `migrate()`, add:

```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  feishu_user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  granted_at INTEGER NOT NULL
)
```

Add methods to Database class:

```typescript
saveToken(feishuUserId: string, token: OAuthToken): void {
  this.db.prepare(`
    INSERT OR REPLACE INTO oauth_tokens
    (feishu_user_id, access_token, refresh_token, expires_at, refresh_expires_at, scope, granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(feishuUserId, token.accessToken, token.refreshToken,
    token.expiresAt, token.refreshExpiresAt, token.scope, token.grantedAt);
}

getToken(feishuUserId: string): OAuthToken | null {
  const row = this.db.prepare(
    'SELECT * FROM oauth_tokens WHERE feishu_user_id = ?'
  ).get(feishuUserId) as any;
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
  this.db.prepare('DELETE FROM oauth_tokens WHERE feishu_user_id = ?').run(feishuUserId);
}
```

Export `OAuthToken` interface:

```typescript
export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;      // Unix ms
  refreshExpiresAt: number; // Unix ms
  scope: string;
  grantedAt: number;      // Unix ms
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/db.test.ts`

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/session/db.ts src/session/db.test.ts
git commit -m "feat: add oauth_tokens table for per-user token storage"
```

---

### Task 2: Implement OAuth Device Flow

**Files:**
- Create: `src/auth/device-flow.ts`
- Test: `src/auth/device-flow.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/core/device-flow.js`

- [ ] **Step 1: Write tests**

Test cases:
1. `requestDeviceAuthorization` — mock fetch, verify request format (Basic auth, form-urlencoded, offline_access scope)
2. `requestDeviceAuthorization` — verify response parsing (deviceCode, userCode, verificationUri, expiresIn, interval)
3. `pollDeviceToken` — mock fetch returning `authorization_pending` then success, verify polling behavior
4. `pollDeviceToken` — mock `access_denied` error, verify returns `{ ok: false }`
5. `pollDeviceToken` — mock `slow_down`, verify interval increases

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/auth/device-flow.test.ts`

- [ ] **Step 3: Implement device-flow.ts**

```typescript
// src/auth/device-flow.ts
import { logger } from '../logger.js';

const FEISHU_DEVICE_AUTH_URL = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface TokenResult {
  ok: true;
  token: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    refreshExpiresIn: number;
    scope: string;
  };
} | { ok: false; error: string; message: string };

export async function requestDeviceAuthorization(
  appId: string, appSecret: string, scope: string,
): Promise<DeviceAuthResponse> {
  // Force offline_access for refresh token
  if (!scope.includes('offline_access')) {
    scope = scope ? `${scope} offline_access` : 'offline_access';
  }

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');
  const body = new URLSearchParams({ client_id: appId, scope });

  const resp = await fetch(FEISHU_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });
  const data = await resp.json();

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete ?? data.verification_uri,
    expiresIn: data.expires_in ?? 240,
    interval: data.interval ?? 5,
  };
}

export async function pollDeviceToken(params: {
  appId: string; appSecret: string; deviceCode: string;
  interval: number; expiresIn: number; signal?: AbortSignal;
}): Promise<TokenResult> {
  const { appId, appSecret, deviceCode, expiresIn, signal } = params;
  let interval = params.interval;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: 'cancelled', message: '授权已取消' };
    await sleep(interval * 1000, signal);

    const resp = await fetch(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: appId,
        client_secret: appSecret,
      }).toString(),
    });
    const data = await resp.json();

    if (!data.error && data.access_token) {
      return {
        ok: true,
        token: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? '',
          expiresIn: data.expires_in ?? 7200,
          refreshExpiresIn: data.refresh_token_expires_in ?? 604800,
          scope: data.scope ?? '',
        },
      };
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { interval = Math.min(interval + 5, 60); continue; }
    if (data.error === 'access_denied') return { ok: false, error: 'access_denied', message: '用户拒绝了授权' };
    if (data.error === 'expired_token' || data.error === 'invalid_grant') {
      return { ok: false, error: 'expired_token', message: '授权码已过期' };
    }
  }
  return { ok: false, error: 'expired_token', message: '授权超时' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/auth/device-flow.ts src/auth/device-flow.test.ts
git commit -m "feat: implement OAuth Device Flow for Feishu"
```

---

### Task 3: Implement token store with auto-refresh

**Files:**
- Create: `src/auth/token-store.ts`
- Test: `src/auth/token-store.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/core/uat-client.js`

- [ ] **Step 1: Write tests**

Test cases:
1. `getValidAccessToken` — token is valid → returns accessToken
2. `getValidAccessToken` — token expired, refresh succeeds → returns new accessToken, DB updated
3. `getValidAccessToken` — no token → throws NeedAuthorizationError
4. `getValidAccessToken` — refresh_token expired → deletes token, throws NeedAuthorizationError
5. `refreshToken` — server error (code 20050) → retries once

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement token-store.ts**

```typescript
// src/auth/token-store.ts
import type { Database, OAuthToken } from '../session/db.js';
import { logger } from '../logger.js';

const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const REFRESH_TOKEN_RETRYABLE = new Set([20050]);

export class NeedAuthorizationError extends Error {
  constructor(public userId: string) {
    super('need_user_authorization');
    this.name = 'NeedAuthorizationError';
  }
}

// Prevent concurrent refresh for same user
const refreshLocks = new Map<string, Promise<OAuthToken | null>>();

export async function getValidAccessToken(
  db: Database, userId: string, appId: string, appSecret: string,
): Promise<string> {
  const stored = db.getToken(userId);
  if (!stored) throw new NeedAuthorizationError(userId);

  // Token still valid (with 60s buffer)
  if (Date.now() < stored.expiresAt - 60_000) {
    return stored.accessToken;
  }

  // Refresh token expired
  if (Date.now() >= stored.refreshExpiresAt) {
    db.deleteToken(userId);
    throw new NeedAuthorizationError(userId);
  }

  // Needs refresh
  const refreshed = await refreshWithLock(db, userId, appId, appSecret, stored);
  if (!refreshed) throw new NeedAuthorizationError(userId);
  return refreshed.accessToken;
}

async function refreshWithLock(
  db: Database, userId: string, appId: string, appSecret: string, stored: OAuthToken,
): Promise<OAuthToken | null> {
  const existing = refreshLocks.get(userId);
  if (existing) { await existing; return db.getToken(userId); }

  const promise = doRefresh(db, userId, appId, appSecret, stored);
  refreshLocks.set(userId, promise);
  try { return await promise; }
  finally { refreshLocks.delete(userId); }
}

async function doRefresh(
  db: Database, userId: string, appId: string, appSecret: string, stored: OAuthToken,
): Promise<OAuthToken | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
    client_id: appId,
    client_secret: appSecret,
  }).toString();

  const callEndpoint = async () => {
    const resp = await fetch(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return await resp.json();
  };

  let data = await callEndpoint();

  if (data.code && data.code !== 0) {
    if (REFRESH_TOKEN_RETRYABLE.has(data.code)) {
      logger.warn({ code: data.code }, 'Token refresh transient error, retrying');
      data = await callEndpoint();
    }
    if (data.code && data.code !== 0) {
      logger.warn({ code: data.code }, 'Token refresh failed, deleting token');
      db.deleteToken(userId);
      return null;
    }
  }

  if (!data.access_token) { db.deleteToken(userId); return null; }

  const now = Date.now();
  const updated: OAuthToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: now + (data.expires_in ?? 7200) * 1000,
    refreshExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : stored.refreshExpiresAt,
    scope: data.scope ?? stored.scope,
    grantedAt: stored.grantedAt,
  };
  db.saveToken(userId, updated);
  return updated;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-store.ts src/auth/token-store.test.ts
git commit -m "feat: add token store with auto-refresh for OAuth"
```

---

### Task 4: Implement Feishu MCP endpoint caller

**Files:**
- Create: `src/tools/feishu-mcp.ts`
- Test: `src/tools/feishu-mcp.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/tools/mcp/shared.js` lines 116-156

- [ ] **Step 1: Write tests**

Test cases:
1. `callFeishuMcp` — success → returns parsed result
2. `callFeishuMcp` — JSON-RPC error → throws with message
3. `callFeishuMcp` — HTTP error → throws with status
4. `callFeishuMcp` — nested JSON-RPC result → unwraps correctly

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement feishu-mcp.ts**

```typescript
// src/tools/feishu-mcp.ts
import { logger } from '../logger.js';

const MCP_ENDPOINT = 'https://mcp.feishu.cn/mcp';

export async function callFeishuMcp(
  toolName: string, args: Record<string, unknown>, userAccessToken: string,
): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: `${toolName}-${Date.now()}`,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  const resp = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Lark-MCP-UAT': userAccessToken,
      'X-Lark-MCP-Allowed-Tools': toolName,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 1000)}`);
  }

  const data = await resp.json();
  if (data.error) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }
  return unwrapResult(data.result);
}

function unwrapResult(v: any): any {
  if (v && typeof v === 'object' && 'result' in v && !('jsonrpc' in v)) {
    return unwrapResult(v.result);
  }
  if (v && typeof v === 'object' && v.jsonrpc && 'result' in v) {
    return unwrapResult(v.result);
  }
  if (v && typeof v === 'object' && v.jsonrpc && v.error) {
    throw new Error(v.error.message ?? 'MCP error');
  }
  return v;
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-mcp.ts src/tools/feishu-mcp.test.ts
git commit -m "feat: add Feishu MCP endpoint caller (JSON-RPC 2.0)"
```

---

### Task 5: Create in-process MCP server with doc tools

**Files:**
- Create: `src/tools/feishu-doc-server.ts`
- Test: `src/tools/feishu-doc-server.test.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/tools/mcp/doc/` (schemas, validation)

- [ ] **Step 1: Write tests**

Test cases:
1. `createFeishuDocServer` returns a valid MCP server config
2. Tool `feishu_doc_create` — calls MCP endpoint with correct params, returns doc_url
3. Tool `feishu_doc_fetch` — calls MCP endpoint, returns markdown content
4. Tool `feishu_doc_update` — validates mode, calls MCP endpoint
5. Tool `feishu_doc_create` — no token → returns auth-needed error message (not throw)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement feishu-doc-server.ts**

```typescript
// src/tools/feishu-doc-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callFeishuMcp } from './feishu-mcp.js';
import { getValidAccessToken, NeedAuthorizationError } from '../auth/token-store.js';
import type { Database } from '../session/db.js';
import { logger } from '../logger.js';

const DOC_SCOPES = 'docx:document:create docx:document:readonly docx:document:write_only';

export function createFeishuDocServer(userId: string, db: Database, appId: string, appSecret: string) {
  const withToken = async (fn: (token: string) => Promise<unknown>) => {
    try {
      const token = await getValidAccessToken(db, userId, appId, appSecret);
      return await fn(token);
    } catch (err) {
      if (err instanceof NeedAuthorizationError) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'need_authorization',
            message: `用户需要先完成飞书 OAuth 授权才能使用文档功能。请提示用户发送 /auth 命令进行授权。`,
            scopes: DOC_SCOPES,
          }) }],
        };
      }
      throw err;
    }
  };

  const createDoc = tool(
    'feishu_doc_create',
    '创建飞书云文档。传入 Markdown 内容和标题，返回文档链接。',
    { title: z.string().describe('文档标题'), markdown: z.string().describe('Lark-flavored Markdown 内容'),
      folder_token: z.string().optional().describe('目标文件夹 token（可选）') },
    async (args) => withToken(async (token) => {
      const result = await callFeishuMcp('create-doc', args, token);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }) as any,
  );

  const fetchDoc = tool(
    'feishu_doc_fetch',
    '读取飞书云文档内容。传入文档 ID 或 URL，返回 Markdown 格式内容。',
    { doc_id: z.string().describe('文档 ID 或 URL'),
      offset: z.number().int().min(0).optional().describe('字符偏移（分页用）'),
      limit: z.number().int().min(1).optional().describe('最大返回字符数') },
    async (args) => withToken(async (token) => {
      const result = await callFeishuMcp('fetch-doc', args, token);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }) as any,
  );

  const updateDoc = tool(
    'feishu_doc_update',
    '更新飞书云文档。支持覆盖、追加、范围替换等模式。',
    { doc_id: z.string().describe('文档 ID 或 URL'),
      markdown: z.string().optional().describe('Markdown 内容'),
      mode: z.enum(['overwrite', 'append', 'replace_range', 'replace_all', 'insert_before', 'insert_after', 'delete_range']).describe('更新模式'),
      selection_with_ellipsis: z.string().optional().describe('范围定位：开头...结尾'),
      selection_by_title: z.string().optional().describe('标题定位：如 ## 章节'),
      new_title: z.string().optional().describe('新标题（可选）') },
    async (args) => withToken(async (token) => {
      const result = await callFeishuMcp('update-doc', args, token);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }) as any,
  );

  return createSdkMcpServer({
    name: 'feishu-docs',
    version: '1.0.0',
    tools: [createDoc, fetchDoc, updateDoc],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-doc-server.ts src/tools/feishu-doc-server.test.ts
git commit -m "feat: create in-process MCP server with Feishu doc tools"
```

---

### Task 6: Inject MCP server into executor and wire up dispatch

**Files:**
- Modify: `src/claude/executor.ts`
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Update executor to accept userId and db, create MCP server**

In `executor.ts`, modify `executeClaudeTask` signature:

```typescript
export async function executeClaudeTask(
  prompt: string, cwd: string, resumeSessionId: string | null,
  abortController: AbortController, callbacks: ExecutionCallbacks,
  model?: string,
  userId?: string,  // NEW
  db?: Database,    // NEW
): Promise<void> {
```

Inside the function, before `query()`, create the MCP server:

```typescript
import { createFeishuDocServer } from '../tools/feishu-doc-server.js';

// Build MCP servers
const mcpServers: Record<string, any> = {};
if (userId && db) {
  const appId = process.env.FEISHU_APP_ID ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET ?? '';
  if (appId && appSecret) {
    mcpServers['feishu-docs'] = createFeishuDocServer(userId, db, appId, appSecret);
  }
}

const conversation = query({
  prompt,
  options: {
    // ... existing options ...
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  },
});
```

- [ ] **Step 2: Update dispatch to pass userId and db**

In `dispatch.ts` `handleClaudeTask`, update the `executeClaudeTask` call to pass `ctx.senderId` and `db`:

```typescript
await executeClaudeTask(
  prompt, projectPath, session.claude_session_id,
  abortController, callbacks, userModel,
  ctx.senderId, db,  // NEW
);
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/claude/executor.ts src/messaging/inbound/dispatch.ts
git commit -m "feat: inject Feishu doc MCP server into Claude executor"
```

---

### Task 7: Add /auth command and OAuth card flow

**Files:**
- Create: `src/auth/oauth-card.ts`
- Modify: `src/utils/command.ts`
- Modify: `src/messaging/inbound/dispatch.ts`

Reference: `/tmp/openclaw-lark-latest/extracted/package/src/tools/oauth.js` (auth card, identity verification, polling flow)

- [ ] **Step 1: Create OAuth card builder**

```typescript
// src/auth/oauth-card.ts
import type { FeishuCard } from '../card/builder.js';

export function buildOAuthCard(authUrl: string, userCode: string): FeishuCard {
  return {
    header: { title: { tag: 'plain_text', content: '🔑 飞书账号授权' }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: `需要授权才能访问飞书文档。\n\n点击下方按钮完成授权，授权码: **${userCode}**` },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '前往授权' }, type: 'primary',
          multi_url: { url: authUrl, pc_url: authUrl, android_url: authUrl, ios_url: authUrl } },
      ] },
      { tag: 'markdown', content: '授权完成后将自动继续操作。', text_size: 'notation' },
    ],
  };
}

export function buildOAuthSuccessCard(): FeishuCard {
  return {
    elements: [{ tag: 'markdown', content: '✓ 飞书授权成功', text_size: 'notation' }],
  };
}

export function buildOAuthFailedCard(reason: string): FeishuCard {
  return {
    elements: [{ tag: 'markdown', content: `✗ 授权失败: ${reason}`, text_size: 'notation' }],
  };
}
```

- [ ] **Step 2: Add /auth command**

In `command.ts`, add `'auth'` to `ParsedCommand.type` and handle `/auth` in `parseCommand`.

In `dispatch.ts` `handleCommand`, add:

```typescript
case 'auth': {
  const { requestDeviceAuthorization, pollDeviceToken } = await import('../../auth/device-flow.js');
  const { buildOAuthCard, buildOAuthSuccessCard, buildOAuthFailedCard } = await import('../../auth/oauth-card.js');
  const appId = config.feishu.appId;
  const appSecret = config.feishu.appSecret;
  const scopes = 'docx:document:create docx:document:readonly docx:document:write_only';

  try {
    const deviceAuth = await requestDeviceAuthorization(appId, appSecret, scopes);
    const card = buildOAuthCard(deviceAuth.verificationUriComplete, deviceAuth.userCode);
    const cardResp = await sendCard(ctx.chatId, card, ctx.threadId ?? undefined);

    // Poll in background
    pollDeviceToken({
      appId, appSecret,
      deviceCode: deviceAuth.deviceCode,
      interval: deviceAuth.interval,
      expiresIn: deviceAuth.expiresIn,
    }).then(async (result) => {
      if (result.ok) {
        // Verify identity (prevent group chat hijacking)
        const identityResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
          headers: { Authorization: `Bearer ${result.token.accessToken}` },
        });
        const identity = await identityResp.json();
        const actualOpenId = identity.data?.open_id;

        if (actualOpenId && actualOpenId !== ctx.senderId) {
          if (cardResp?.messageId) await updateCard(cardResp.messageId, buildOAuthFailedCard('授权用户与发起用户不匹配'));
          return;
        }

        const now = Date.now();
        db.saveToken(ctx.senderId, {
          accessToken: result.token.accessToken,
          refreshToken: result.token.refreshToken,
          expiresAt: now + result.token.expiresIn * 1000,
          refreshExpiresAt: now + result.token.refreshExpiresIn * 1000,
          scope: result.token.scope,
          grantedAt: now,
        });
        if (cardResp?.messageId) await updateCard(cardResp.messageId, buildOAuthSuccessCard());
      } else {
        if (cardResp?.messageId) await updateCard(cardResp.messageId, buildOAuthFailedCard(result.message));
      }
    }).catch(err => logger.error({ err }, 'OAuth polling failed'));

    return;
  } catch (err: any) {
    await reply(`授权发起失败: ${err.message}`);
    return;
  }
}
```

- [ ] **Step 3: Update /help text**

Add `/auth — 授权飞书账号（文档读写）` to help text.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-card.ts src/utils/command.ts src/messaging/inbound/dispatch.ts
git commit -m "feat: add /auth command with OAuth Device Flow and auth cards"
```

---

### Task 8: End-to-end manual testing

- [ ] **Step 1: Test OAuth flow**

1. Start bot: `npx tsx src/index.ts`
2. Send `/auth` to bot
3. Verify: bot sends authorization card with link
4. Click link, complete authorization in browser
5. Verify: card updates to "授权成功"

- [ ] **Step 2: Test document creation**

1. Send "帮我创建一个飞书文档，标题是'测试文档'，内容随便写点"
2. Verify: Claude calls `feishu_doc_create`, returns document URL
3. Open URL, verify document exists with content

- [ ] **Step 3: Test document reading**

1. Send a Feishu doc URL to bot: "读一下这个文档 https://xxx.feishu.cn/docx/xxx"
2. Verify: Claude calls `feishu_doc_fetch`, returns document content in reply

- [ ] **Step 4: Test document updating**

1. Send "在刚才那个文档末尾追加一段总结"
2. Verify: Claude calls `feishu_doc_update` with mode=append

- [ ] **Step 5: Test unauthorized flow**

1. Delete token from DB (or use a new user)
2. Send "帮我创建飞书文档"
3. Verify: Claude's tool call returns auth-needed error, Claude tells user to run /auth

- [ ] **Step 6: Final commit if needed**

```bash
git status
git commit -m "feat: Feishu Docs + OAuth support"
```
