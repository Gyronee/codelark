import * as lark from '@larksuiteoapi/node-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
  data?: unknown;
}

export async function callFeishuOapi(opts: OapiCallOptions): Promise<OapiResponse> {
  const url = new URL(opts.path, FEISHU_BASE_URL);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${opts.userAccessToken}`,
  };
  if (opts.body) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  const res = await fetch(url.toString(), {
    method: opts.method,
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`);
  }

  return await res.json() as OapiResponse;
}

/** Assert Feishu API response code is 0. Accepts any Lark SDK response shape. */
export function assertOk(res: { code: number; msg: string }): void {
  if (res.code !== 0) {
    throw new Error(`Feishu API error ${res.code}: ${res.msg}`);
  }
}

/** Wrap a result object as a CallToolResult for MCP. */
export function toToolResult(result: unknown): CallToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

/** Type for the withToken callback pattern used by all tool factories. */
export type WithTokenFn = (action: (token: string) => Promise<CallToolResult>) => Promise<CallToolResult>;

export function createLarkClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({ appId, appSecret });
}
