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

export function assertOk(res: OapiResponse): void {
  if (res.code !== 0) {
    throw new Error(`Feishu API error ${res.code}: ${res.msg}`);
  }
}

export function createLarkClient(appId: string, appSecret: string): lark.Client {
  return new lark.Client({ appId, appSecret });
}
