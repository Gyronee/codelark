# Feishu Document Tools Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 missing Feishu document tools (search, wiki space, wiki node, drive file, doc media, doc comments) to match the official plugin's feature set.

**Architecture:** New tools call Feishu Open API directly with user access tokens (UAT), using the same `withToken()` pattern as existing doc tools. Each tool domain lives in its own file, all tools are registered into the existing `feishu-docs` MCP server. A shared `callFeishuOapi()` helper handles authenticated REST calls.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (tool/createSdkMcpServer), `@larksuiteoapi/node-sdk` (Lark Client for SDK-style calls), zod, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/tools/feishu-oapi.ts` | **NEW** — Shared helper: create Lark Client, `callFeishuOapi()` for raw REST, `assertOk()` for response validation |
| `src/tools/feishu-search.ts` | **NEW** — `feishu_search_doc_wiki` tool (search action) |
| `src/tools/feishu-wiki.ts` | **NEW** — `feishu_wiki_space` (list/get/create) + `feishu_wiki_space_node` (list/get/create/move/copy) tools |
| `src/tools/feishu-drive.ts` | **NEW** — `feishu_drive_file` tool (list/get_meta/copy/move/delete/upload/download) |
| `src/tools/feishu-doc-media.ts` | **NEW** — `feishu_doc_media` tool (insert/download) |
| `src/tools/feishu-doc-comments.ts` | **NEW** — `feishu_doc_comments` tool (list/create/patch) |
| `src/tools/feishu-doc-server.ts` | **MODIFY** — Import new tools, register them into `createSdkMcpServer` |
| `src/claude/executor.ts` | **MODIFY** — Add new tool names to `allowedTools` |
| `src/messaging/inbound/dispatch.ts` | **MODIFY** — Expand OAuth scopes |
| `src/tools/feishu-oapi.test.ts` | **NEW** — Tests for OAPI helper |
| `src/tools/feishu-search.test.ts` | **NEW** — Tests for search tool |
| `src/tools/feishu-wiki.test.ts` | **NEW** — Tests for wiki tools |
| `src/tools/feishu-drive.test.ts` | **NEW** — Tests for drive tool |
| `src/tools/feishu-doc-media.test.ts` | **NEW** — Tests for doc media tool |
| `src/tools/feishu-doc-comments.test.ts` | **NEW** — Tests for doc comments tool |

---

### Task 1: OAPI Helper — `src/tools/feishu-oapi.ts`

**Files:**
- Create: `src/tools/feishu-oapi.ts`
- Create: `src/tools/feishu-oapi.test.ts`

A shared helper for calling Feishu Open API endpoints with user access tokens. Two approaches: raw HTTP for simple endpoints (search), Lark SDK Client for SDK-style calls (wiki, drive, etc.).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/feishu-oapi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callFeishuOapi, assertOk, createLarkClient } from './feishu-oapi.js';

describe('callFeishuOapi', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('calls endpoint with UAT and returns parsed data', async () => {
    const mockResponse = { code: 0, msg: 'success', data: { items: [] } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 })
    );

    const result = await callFeishuOapi({
      method: 'POST',
      path: '/open-apis/search/v2/doc_wiki/search',
      body: { query: 'test' },
      userAccessToken: 'u-token',
    });

    expect(result).toEqual(mockResponse);
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe('https://open.feishu.cn/open-apis/search/v2/doc_wiki/search');
    expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer u-token');
  });

  it('throws on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Error', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(callFeishuOapi({
      method: 'GET',
      path: '/open-apis/wiki/v2/spaces',
      userAccessToken: 'u-token',
    })).rejects.toThrow('HTTP 500');
  });
});

describe('assertOk', () => {
  it('does nothing when code is 0', () => {
    expect(() => assertOk({ code: 0, msg: 'success', data: {} })).not.toThrow();
  });

  it('throws when code is non-zero', () => {
    expect(() => assertOk({ code: 99991, msg: 'invalid token' })).toThrow('invalid token');
  });
});

describe('createLarkClient', () => {
  it('returns a Lark Client instance', () => {
    const client = createLarkClient('app-id', 'app-secret');
    expect(client).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/feishu-oapi.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/feishu-oapi.ts
import * as lark from '@larksuiteoapi/node-sdk';

const FEISHU_BASE_URL = 'https://open.feishu.cn';

export interface OapiCallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  userAccessToken: string;
}

export interface OapiResponse {
  code: number;
  msg: string;
  data?: any;
}

/**
 * Call Feishu Open API with user access token (for endpoints not covered by SDK).
 */
export async function callFeishuOapi(opts: OapiCallOptions): Promise<OapiResponse> {
  const url = new URL(opts.path, FEISHU_BASE_URL);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${opts.userAccessToken}`,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`);
  }

  return JSON.parse(text) as OapiResponse;
}

/**
 * Assert Feishu API response code is 0. Throws on error.
 */
export function assertOk(res: OapiResponse): void {
  if (res.code !== 0) {
    throw new Error(`Feishu API error ${res.code}: ${res.msg}`);
  }
}

/**
 * Create a Lark SDK Client for SDK-style API calls.
 * Pass { userAccessToken } in request options for UAT calls.
 */
export function createLarkClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({ appId, appSecret });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/feishu-oapi.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-oapi.ts src/tools/feishu-oapi.test.ts
git commit -m "feat: add Feishu OAPI helper for direct API calls with UAT"
```

---

### Task 2: Document Search — `src/tools/feishu-search.ts`

**Files:**
- Create: `src/tools/feishu-search.ts`
- Create: `src/tools/feishu-search.test.ts`

Implements `feishu_search_doc_wiki` tool. Uses `callFeishuOapi()` to call `POST /open-apis/search/v2/doc_wiki/search`. Reference: `/tmp/openclaw-lark/package/src/tools/oapi/search/doc-search.js`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tools/feishu-search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-oapi.js', () => ({
  callFeishuOapi: vi.fn(),
  assertOk: vi.fn(),
}));

const { callFeishuOapi } = await import('./feishu-oapi.js');
const mockCallOapi = vi.mocked(callFeishuOapi);

import { handleSearch } from './feishu-search.js';

describe('handleSearch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls search API with query and empty filters by default', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [{ title: 'Test Doc' }], total: 1, has_more: false },
    });

    const result = await handleSearch({ query: 'test' }, 'u-token');

    expect(mockCallOapi).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/open-apis/search/v2/doc_wiki/search',
      userAccessToken: 'u-token',
    }));
    const body = mockCallOapi.mock.calls[0][0].body!;
    expect(body.query).toBe('test');
    expect(body.doc_filter).toEqual({});
    expect(body.wiki_filter).toEqual({});

    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
  });

  it('applies filter to both doc_filter and wiki_filter', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: false },
    });

    await handleSearch({
      query: 'design',
      filter: { doc_types: ['DOCX', 'WIKI'], only_title: true },
    }, 'u-token');

    const body = mockCallOapi.mock.calls[0][0].body!;
    expect(body.doc_filter).toEqual({ doc_types: ['DOCX', 'WIKI'], only_title: true });
    expect(body.wiki_filter).toEqual({ doc_types: ['DOCX', 'WIKI'], only_title: true });
  });

  it('supports empty query for browse-style search', async () => {
    mockCallOapi.mockResolvedValue({
      code: 0, msg: 'success',
      data: { res_units: [], total: 0, has_more: false },
    });

    await handleSearch({}, 'u-token');
    expect(mockCallOapi.mock.calls[0][0].body!.query).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/feishu-search.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/feishu-search.ts
/**
 * feishu_search_doc_wiki — Search Feishu documents and wikis.
 * Uses POST /open-apis/search/v2/doc_wiki/search with UAT.
 * Reference: official plugin src/tools/oapi/search/doc-search.js
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callFeishuOapi, assertOk } from './feishu-oapi.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const TimeRangeSchema = z.object({
  start: z.string().optional().describe("起始时间，ISO 8601 格式，如 '2024-01-01T00:00:00+08:00'"),
  end: z.string().optional().describe("截止时间，ISO 8601 格式"),
});

const DocTypeEnum = z.enum([
  'DOC', 'SHEET', 'BITABLE', 'MINDNOTE', 'FILE', 'WIKI', 'DOCX', 'FOLDER', 'CATALOG', 'SLIDES', 'SHORTCUT',
]);

const SortTypeEnum = z.enum([
  'DEFAULT_TYPE', 'OPEN_TIME', 'EDIT_TIME', 'EDIT_TIME_ASC', 'CREATE_TIME',
]).describe('排序方式。EDIT_TIME=编辑时间降序（推荐）');

const FilterSchema = z.object({
  creator_ids: z.array(z.string()).max(20).optional().describe('创建者 OpenID 列表（最多 20 个）'),
  doc_types: z.array(DocTypeEnum).max(10).optional().describe('文档类型列表'),
  only_title: z.boolean().optional().describe('仅搜索标题（默认 false）'),
  open_time: TimeRangeSchema.optional(),
  sort_type: SortTypeEnum.optional(),
  create_time: TimeRangeSchema.optional(),
}).describe('搜索过滤条件');

export interface SearchParams {
  query?: string;
  filter?: {
    creator_ids?: string[];
    doc_types?: string[];
    only_title?: boolean;
    open_time?: { start?: string; end?: string };
    sort_type?: string;
    create_time?: { start?: string; end?: string };
  };
  page_token?: string;
  page_size?: number;
}

export interface SearchResult {
  total: number;
  has_more: boolean;
  results: unknown[];
  page_token?: string;
}

/**
 * Convert ISO 8601 time range to Unix timestamp range (seconds) for the API.
 */
function convertTimeRange(range: { start?: string; end?: string }): { start?: string; end?: string } {
  const converted: { start?: string; end?: string } = {};
  if (range.start) converted.start = String(Math.floor(new Date(range.start).getTime() / 1000));
  if (range.end) converted.end = String(Math.floor(new Date(range.end).getTime() / 1000));
  return converted;
}

/**
 * Convert Unix timestamps in search results to ISO 8601 for readability.
 */
function normalizeTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTimestamps);
  if (!value || typeof value !== 'object') return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith('_time') && typeof item === 'string') {
      const num = Number(item);
      if (!isNaN(num) && num > 1e9 && num < 1e11) {
        normalized[key] = new Date(num * 1000).toISOString();
        continue;
      }
    }
    normalized[key] = normalizeTimestamps(item);
  }
  return normalized;
}

/**
 * Core search logic — exported for testing.
 */
export async function handleSearch(params: SearchParams, userAccessToken: string): Promise<SearchResult> {
  const query = params.query ?? '';

  const requestData: Record<string, unknown> = {
    query,
    page_size: params.page_size,
    page_token: params.page_token,
  };

  // Must always pass doc_filter and wiki_filter (API requirement)
  if (params.filter) {
    const filter = { ...params.filter };
    if (filter.open_time) filter.open_time = convertTimeRange(filter.open_time);
    if (filter.create_time) filter.create_time = convertTimeRange(filter.create_time);
    requestData.doc_filter = { ...filter };
    requestData.wiki_filter = { ...filter };
  } else {
    requestData.doc_filter = {};
    requestData.wiki_filter = {};
  }

  const res = await callFeishuOapi({
    method: 'POST',
    path: '/open-apis/search/v2/doc_wiki/search',
    body: requestData,
    userAccessToken,
  });

  assertOk(res);
  const data = res.data || {};

  return {
    total: data.total ?? 0,
    has_more: data.has_more ?? false,
    results: normalizeTimestamps(data.res_units) as unknown[] ?? [],
    page_token: data.page_token,
  };
}

/**
 * Creates the feishu_search_doc_wiki tool for the MCP server.
 */
export function createSearchTool(
  withTokenFn: (action: (token: string) => Promise<CallToolResult>) => Promise<CallToolResult>,
) {
  return tool(
    'feishu_search_doc_wiki',
    '飞书文档与 Wiki 统一搜索。同时搜索云空间文档和知识库 Wiki。' +
    'query 为搜索关键词（可选，不传则返回最近浏览文档）。' +
    'filter 可按文档类型、创建者、时间等筛选。返回结果包含标题和摘要高亮。',
    {
      query: z.string().max(50).optional().describe('搜索关键词（可选，不传返回最近浏览文档）'),
      filter: FilterSchema.optional(),
      page_token: z.string().optional().describe('分页标记'),
      page_size: z.number().int().min(0).max(20).optional().describe('分页大小（默认 15，最大 20）'),
    },
    async (args) =>
      withTokenFn(async (token) => {
        const result = await handleSearch(args, token);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/feishu-search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-search.ts src/tools/feishu-search.test.ts
git commit -m "feat: add feishu_search_doc_wiki tool"
```

---

### Task 3: Wiki Tools — `src/tools/feishu-wiki.ts`

**Files:**
- Create: `src/tools/feishu-wiki.ts`
- Create: `src/tools/feishu-wiki.test.ts`

Implements `feishu_wiki_space` (list/get/create) and `feishu_wiki_space_node` (list/get/create/move/copy). Uses Lark SDK with UAT. Reference: official plugin `src/tools/oapi/wiki/space.js` and `space-node.js`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/tools/feishu-wiki.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./feishu-oapi.js', () => ({
  callFeishuOapi: vi.fn(),
  assertOk: vi.fn(),
  createLarkClient: vi.fn(() => ({
    wiki: {
      space: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        getNode: vi.fn(),
      },
      spaceNode: {
        list: vi.fn(),
        create: vi.fn(),
        move: vi.fn(),
        copy: vi.fn(),
      },
    },
  })),
}));

const { createLarkClient } = await import('./feishu-oapi.js');
const mockClient = vi.mocked(createLarkClient)();

import { handleWikiSpace, handleWikiSpaceNode } from './feishu-wiki.js';

describe('handleWikiSpace', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('list: returns spaces with pagination', async () => {
    vi.mocked(mockClient.wiki.space.list).mockResolvedValue({
      code: 0, msg: 'success',
      data: { items: [{ space_id: 's1', name: 'Test Wiki' }], has_more: false },
    } as any);

    const result = await handleWikiSpace(
      { action: 'list', page_size: 10 },
      'u-token',
      mockClient as any,
    );

    expect(result.spaces).toHaveLength(1);
    expect(result.spaces![0].space_id).toBe('s1');
  });

  it('get: returns space details', async () => {
    vi.mocked(mockClient.wiki.space.get).mockResolvedValue({
      code: 0, msg: 'success',
      data: { space: { space_id: 's1', name: 'My Wiki' } },
    } as any);

    const result = await handleWikiSpace(
      { action: 'get', space_id: 's1' },
      'u-token',
      mockClient as any,
    );

    expect(result.space?.name).toBe('My Wiki');
  });

  it('create: creates new space', async () => {
    vi.mocked(mockClient.wiki.space.create).mockResolvedValue({
      code: 0, msg: 'success',
      data: { space: { space_id: 's-new', name: 'New Wiki' } },
    } as any);

    const result = await handleWikiSpace(
      { action: 'create', name: 'New Wiki', description: 'test' },
      'u-token',
      mockClient as any,
    );

    expect(result.space?.space_id).toBe('s-new');
  });
});

describe('handleWikiSpaceNode', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('list: returns nodes in space', async () => {
    vi.mocked(mockClient.wiki.spaceNode.list).mockResolvedValue({
      code: 0, msg: 'success',
      data: { items: [{ node_token: 'n1', title: 'Page 1' }], has_more: false },
    } as any);

    const result = await handleWikiSpaceNode(
      { action: 'list', space_id: 's1' },
      'u-token',
      mockClient as any,
    );

    expect(result.nodes).toHaveLength(1);
  });

  it('get: resolves wiki token to obj_token', async () => {
    vi.mocked(mockClient.wiki.space.getNode).mockResolvedValue({
      code: 0, msg: 'success',
      data: { node: { node_token: 'n1', obj_token: 'doc123', obj_type: 'docx' } },
    } as any);

    const result = await handleWikiSpaceNode(
      { action: 'get', token: 'n1' },
      'u-token',
      mockClient as any,
    );

    expect(result.node?.obj_token).toBe('doc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/feishu-wiki.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/feishu-wiki.ts
/**
 * feishu_wiki_space — Wiki space management (list/get/create)
 * feishu_wiki_space_node — Wiki node management (list/get/create/move/copy)
 * Uses Lark SDK with UAT.
 * Reference: official plugin src/tools/oapi/wiki/space.js, space-node.js
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { assertOk } from './feishu-oapi.js';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// --- Wiki Space ---

export interface WikiSpaceParams {
  action: 'list' | 'get' | 'create';
  space_id?: string;
  name?: string;
  description?: string;
  page_size?: number;
  page_token?: string;
}

export async function handleWikiSpace(
  params: WikiSpaceParams,
  userAccessToken: string,
  client: Client,
): Promise<Record<string, any>> {
  const opts = { userAccessToken } as any;

  switch (params.action) {
    case 'list': {
      const res = await client.wiki.space.list({
        params: { page_size: params.page_size, page_token: params.page_token },
      }, opts);
      assertOk(res as any);
      return {
        spaces: res.data?.items,
        has_more: res.data?.has_more,
        page_token: res.data?.page_token,
      };
    }
    case 'get': {
      const res = await client.wiki.space.get({
        path: { space_id: params.space_id! },
      }, opts);
      assertOk(res as any);
      return { space: res.data?.space };
    }
    case 'create': {
      const res = await client.wiki.space.create({
        data: { name: params.name, description: params.description },
      }, opts);
      assertOk(res as any);
      return { space: (res.data as any)?.space };
    }
  }
}

export function createWikiSpaceTool(
  withTokenFn: (action: (token: string) => Promise<CallToolResult>) => Promise<CallToolResult>,
  client: Client,
) {
  return tool(
    'feishu_wiki_space',
    '飞书知识空间管理。list（列出知识空间）、get（获取空间详情）、create（创建空间）。' +
    'space_id 可从浏览器 URL 获取或通过 list 获取。',
    {
      action: z.enum(['list', 'get', 'create']).describe('操作类型'),
      space_id: z.string().optional().describe('知识空间 ID（get 时必填）'),
      name: z.string().optional().describe('空间名称（create 时）'),
      description: z.string().optional().describe('空间描述（create 时）'),
      page_size: z.number().int().min(1).max(50).optional().describe('分页大小（默认 10）'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => {
        const result = await handleWikiSpace(args as WikiSpaceParams, token, client);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }),
  );
}

// --- Wiki Space Node ---

export interface WikiSpaceNodeParams {
  action: 'list' | 'get' | 'create' | 'move' | 'copy';
  space_id?: string;
  token?: string;
  node_token?: string;
  obj_type?: string;
  parent_node_token?: string;
  node_type?: string;
  origin_node_token?: string;
  title?: string;
  target_parent_token?: string;
  target_space_id?: string;
  page_size?: number;
  page_token?: string;
}

export async function handleWikiSpaceNode(
  params: WikiSpaceNodeParams,
  userAccessToken: string,
  client: Client,
): Promise<Record<string, any>> {
  const opts = { userAccessToken } as any;

  switch (params.action) {
    case 'list': {
      const res = await client.wiki.spaceNode.list({
        path: { space_id: params.space_id! },
        params: {
          page_size: params.page_size,
          page_token: params.page_token,
          parent_node_token: params.parent_node_token,
        },
      }, opts);
      assertOk(res as any);
      return { nodes: res.data?.items, has_more: res.data?.has_more, page_token: res.data?.page_token };
    }
    case 'get': {
      const res = await client.wiki.space.getNode({
        params: { token: params.token!, obj_type: (params.obj_type || 'wiki') as any },
      }, opts);
      assertOk(res as any);
      return { node: res.data?.node };
    }
    case 'create': {
      const res = await client.wiki.spaceNode.create({
        path: { space_id: params.space_id! },
        data: {
          obj_type: params.obj_type as any,
          parent_node_token: params.parent_node_token,
          node_type: params.node_type as any,
          origin_node_token: params.origin_node_token,
          title: params.title,
        },
      }, opts);
      assertOk(res as any);
      return { node: res.data?.node };
    }
    case 'move': {
      const res = await client.wiki.spaceNode.move({
        path: { space_id: params.space_id!, node_token: params.node_token! },
        data: { target_parent_token: params.target_parent_token },
      }, opts);
      assertOk(res as any);
      return { node: res.data?.node };
    }
    case 'copy': {
      const res = await client.wiki.spaceNode.copy({
        path: { space_id: params.space_id!, node_token: params.node_token! },
        data: {
          target_space_id: params.target_space_id,
          target_parent_token: params.target_parent_token,
          title: params.title,
        },
      }, opts);
      assertOk(res as any);
      return { node: res.data?.node };
    }
  }
}

const ObjTypeEnum = z.enum(['doc', 'sheet', 'mindnote', 'bitable', 'file', 'docx', 'slides']);

export function createWikiSpaceNodeTool(
  withTokenFn: (action: (token: string) => Promise<CallToolResult>) => Promise<CallToolResult>,
  client: Client,
) {
  return tool(
    'feishu_wiki_space_node',
    '飞书知识库节点管理。list（列表）、get（获取/将 wiki token 转为 obj_token）、create（创建）、move（移动）、copy（复制）。' +
    '节点是知识库中的文档，包括 doc、docx、sheet、bitable 等。',
    {
      action: z.enum(['list', 'get', 'create', 'move', 'copy']).describe('操作类型'),
      space_id: z.string().optional().describe('知识空间 ID'),
      token: z.string().optional().describe('节点 token（get 时必填）'),
      node_token: z.string().optional().describe('节点 token（move/copy 时必填）'),
      obj_type: z.string().optional().describe('文档类型：doc/sheet/docx/bitable 等（get 默认 wiki）'),
      parent_node_token: z.string().optional().describe('父节点 token'),
      node_type: z.enum(['origin', 'shortcut']).optional().describe('节点类型（create 时）'),
      origin_node_token: z.string().optional().describe('快捷方式源节点 token'),
      title: z.string().optional().describe('标题（create/copy 时）'),
      target_parent_token: z.string().optional().describe('目标父节点 token（move/copy 时）'),
      target_space_id: z.string().optional().describe('目标空间 ID（copy 时跨空间）'),
      page_size: z.number().int().min(1).optional().describe('分页大小'),
      page_token: z.string().optional().describe('分页标记'),
    },
    async (args) =>
      withTokenFn(async (token) => {
        const result = await handleWikiSpaceNode(args as WikiSpaceNodeParams, token, client);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/feishu-wiki.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-wiki.ts src/tools/feishu-wiki.test.ts
git commit -m "feat: add feishu_wiki_space and feishu_wiki_space_node tools"
```

---

### Task 4: Drive File Management — `src/tools/feishu-drive.ts`

**Files:**
- Create: `src/tools/feishu-drive.ts`
- Create: `src/tools/feishu-drive.test.ts`

Implements `feishu_drive_file` tool with actions: list, get_meta, copy, move, delete, upload, download. Uses Lark SDK. Reference: official plugin `src/tools/oapi/drive/file.js`.

- [ ] **Step 1: Write the failing tests**

Tests for list, get_meta, upload (small file), download actions. Pattern identical to wiki tests — mock Lark SDK, call `handleDriveFile()`, verify params and results.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/feishu-drive.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Follow official plugin's pattern closely:
- `list` → `client.drive.file.list()`
- `get_meta` → `client.drive.meta.batchQuery()`
- `copy` → `client.drive.file.copy()`
- `move` → `client.drive.file.move()`
- `delete` → `client.drive.file.delete()`
- `upload` → `client.drive.file.uploadAll()` for < 15MB, chunked for > 15MB
- `download` → `client.drive.file.download()`, save to path or return base64

Key schema fields (from official plugin):
- `folder_token`, `page_size`, `page_token`, `order_by`, `direction` for list
- `request_docs` array for get_meta
- `file_token`, `type`, `name`, `folder_token` for copy/move/delete
- `file_path` or `file_content_base64` for upload
- `file_token`, `output_path` for download

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/feishu-drive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-drive.ts src/tools/feishu-drive.test.ts
git commit -m "feat: add feishu_drive_file tool with list/upload/download/copy/move/delete"
```

---

### Task 5: Doc Media — `src/tools/feishu-doc-media.ts`

**Files:**
- Create: `src/tools/feishu-doc-media.ts`
- Create: `src/tools/feishu-doc-media.test.ts`

Implements `feishu_doc_media` tool with insert (local image/file into doc) and download (media/whiteboard). Uses Lark SDK. Reference: official plugin `src/tools/oapi/drive/doc-media.js`.

- [ ] **Step 1: Write the failing tests**

Test insert flow (3-step: create block → upload media → patch block) and download flow.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write implementation**

Insert flow (from official plugin):
1. Parse doc_id from URL if needed
2. Validate file path and size (max 20MB)
3. `sdk.docx.documentBlockChildren.create()` — create empty image/file block
4. `sdk.drive.v1.media.uploadAll()` — upload file to block
5. `sdk.docx.documentBlock.batchUpdate()` — patch block with file_token

Download flow:
1. `sdk.drive.v1.media.download()` or `sdk.board.v1.whiteboard.downloadAsImage()`
2. Save to output_path, auto-detect extension from Content-Type

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-doc-media.ts src/tools/feishu-doc-media.test.ts
git commit -m "feat: add feishu_doc_media tool for inserting/downloading media"
```

---

### Task 6: Doc Comments — `src/tools/feishu-doc-comments.ts`

**Files:**
- Create: `src/tools/feishu-doc-comments.ts`
- Create: `src/tools/feishu-doc-comments.test.ts`

Implements `feishu_doc_comments` tool with list (with full replies), create, patch (resolve/recover). Uses Lark SDK. Reference: official plugin `src/tools/oapi/drive/doc-comments.js`.

- [ ] **Step 1: Write the failing tests**

Test list (with reply assembly), create (element conversion), patch actions. Also test wiki token auto-conversion.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write implementation**

Key features from official plugin:
- Wiki token auto-conversion via `sdk.wiki.space.getNode()`
- `sdk.drive.v1.fileComment.list()` for listing with pagination
- `assembleCommentsWithReplies()` — fetches complete reply lists for each comment
- `sdk.drive.v1.fileComment.create()` with element conversion (text→text_run, mention→person, link→docs_link)
- `sdk.drive.v1.fileComment.patch()` for resolve/recover

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/tools/feishu-doc-comments.ts src/tools/feishu-doc-comments.test.ts
git commit -m "feat: add feishu_doc_comments tool for managing doc comments"
```

---

### Task 7: Wire Everything Together

**Files:**
- Modify: `src/tools/feishu-doc-server.ts`
- Modify: `src/claude/executor.ts`
- Modify: `src/messaging/inbound/dispatch.ts`

- [ ] **Step 1: Update `feishu-doc-server.ts` — import and register all new tools**

```typescript
// Add to imports:
import { createLarkClient } from './feishu-oapi.js';
import { createSearchTool } from './feishu-search.js';
import { createWikiSpaceTool, createWikiSpaceNodeTool } from './feishu-wiki.js';
import { createDriveFileTool } from './feishu-drive.js';
import { createDocMediaTool } from './feishu-doc-media.js';
import { createDocCommentsTool } from './feishu-doc-comments.js';

// In createFeishuDocServer(), create Lark client and new tools:
const client = createLarkClient(appId, appSecret);
const boundWithToken = (action) => withToken(db, userId, appId, appSecret, action);

const searchTool = createSearchTool(boundWithToken);
const wikiSpaceTool = createWikiSpaceTool(boundWithToken, client);
const wikiSpaceNodeTool = createWikiSpaceNodeTool(boundWithToken, client);
const driveFileTool = createDriveFileTool(boundWithToken, client);
const docMediaTool = createDocMediaTool(boundWithToken, client);
const docCommentsTool = createDocCommentsTool(boundWithToken, client);

// Add all to tools array:
return createSdkMcpServer({
  name: 'feishu-docs',
  version: '1.0.0',
  tools: [
    feishuDocCreate, feishuDocFetch, feishuDocUpdate,
    searchTool, wikiSpaceTool, wikiSpaceNodeTool,
    driveFileTool, docMediaTool, docCommentsTool,
  ],
});
```

- [ ] **Step 2: Update `executor.ts` — add new tools to allowedTools**

```typescript
allowedTools: [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'mcp__feishu-docs__feishu_doc_create',
  'mcp__feishu-docs__feishu_doc_fetch',
  'mcp__feishu-docs__feishu_doc_update',
  // New tools:
  'mcp__feishu-docs__feishu_search_doc_wiki',
  'mcp__feishu-docs__feishu_wiki_space',
  'mcp__feishu-docs__feishu_wiki_space_node',
  'mcp__feishu-docs__feishu_drive_file',
  'mcp__feishu-docs__feishu_doc_media',
  'mcp__feishu-docs__feishu_doc_comments',
],
```

- [ ] **Step 3: Update `dispatch.ts` — expand OAuth scopes**

```typescript
// Current:
const scopes = 'docx:document:create docx:document:readonly docx:document:write_only';

// New (add search, wiki, drive scopes):
const scopes = [
  'docx:document:create',
  'docx:document:readonly',
  'docx:document:write_only',
  'search:docs_wiki:readonly',
  'wiki:wiki:readonly',
  'wiki:wiki',
  'drive:drive:readonly',
  'drive:drive',
].join(' ');
```

Note: Exact scope names should be verified against [Feishu API docs](https://open.feishu.cn/document/server-docs/docs/permission/overview). Users who previously authorized will need to re-run `/auth` to grant new scopes.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Manual smoke test**

1. Start bot: `npm run dev`
2. Send `/auth` in chat → re-authorize with new scopes
3. Test search: ask Claude to search for a document
4. Test wiki: ask Claude to list wiki spaces
5. Test drive: ask Claude to list cloud files

- [ ] **Step 6: Commit**

```bash
git add src/tools/feishu-doc-server.ts src/claude/executor.ts src/messaging/inbound/dispatch.ts
git commit -m "feat: wire all new feishu doc tools into MCP server and executor"
```

---

## OAuth Scope Note

Existing users will need to re-authorize (`/auth`) after this update because new scopes are required. Consider adding a helpful message when a tool call fails with a permission error, suggesting the user run `/auth` again.

## Post-Implementation Verification

- All 9 tools registered in MCP server
- All 9 tools in executor's allowedTools
- All tools auto-allowed via `mcp__feishu-docs__` prefix in canUseTool
- OAuth scopes cover all new API endpoints
- Tests pass for all new modules
