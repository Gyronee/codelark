import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callFeishuOapi, assertOk } from './feishu-oapi.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const FilterSchema = z.object({
  creator_ids: z.array(z.string()).max(20).optional().describe('创建者 OpenID 列表'),
  doc_types: z.array(z.enum([
    'DOC', 'SHEET', 'BITABLE', 'MINDNOTE', 'FILE', 'WIKI', 'DOCX', 'FOLDER', 'CATALOG', 'SLIDES', 'SHORTCUT',
  ])).max(10).optional().describe('文档类型列表'),
  only_title: z.boolean().optional().describe('仅搜索标题（默认 false）'),
  open_time: z.object({
    start: z.string().optional().describe("起始时间 ISO 8601"),
    end: z.string().optional().describe("截止时间 ISO 8601"),
  }).optional(),
  sort_type: z.enum(['DEFAULT_TYPE', 'OPEN_TIME', 'EDIT_TIME', 'EDIT_TIME_ASC', 'CREATE_TIME']).optional()
    .describe('排序方式。EDIT_TIME=编辑时间降序（推荐）'),
  create_time: z.object({
    start: z.string().optional().describe("起始时间 ISO 8601"),
    end: z.string().optional().describe("截止时间 ISO 8601"),
  }).optional(),
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

function convertTimeRange(range: { start?: string; end?: string }): { start?: string; end?: string } {
  const converted: { start?: string; end?: string } = {};
  if (range.start) converted.start = String(Math.floor(new Date(range.start).getTime() / 1000));
  if (range.end) converted.end = String(Math.floor(new Date(range.end).getTime() / 1000));
  return converted;
}

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

export async function handleSearch(params: SearchParams, userAccessToken: string): Promise<SearchResult> {
  const query = params.query ?? '';
  const requestData: Record<string, unknown> = {
    query,
    page_size: params.page_size,
    page_token: params.page_token,
  };

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
    results: (normalizeTimestamps(data.res_units) as unknown[]) ?? [],
    page_token: data.page_token,
  };
}

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
