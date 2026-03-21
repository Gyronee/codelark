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

  it('passes query params in URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 })
    );

    await callFeishuOapi({
      method: 'GET',
      path: '/open-apis/wiki/v2/spaces',
      params: { page_size: '10' },
      userAccessToken: 'u-token',
    });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain('page_size=10');
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

  it('throws on non-JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 200 })
    );

    await expect(callFeishuOapi({
      method: 'GET',
      path: '/open-apis/test',
      userAccessToken: 'u-token',
    })).rejects.toThrow();
  });
});

describe('assertOk', () => {
  it('does nothing when code is 0', () => {
    expect(() => assertOk({ code: 0, msg: 'success', data: {} })).not.toThrow();
  });

  it('throws when code is non-zero', () => {
    expect(() => assertOk({ code: 99991, msg: 'invalid token' })).toThrow('invalid token');
  });

  it('includes error code in message', () => {
    expect(() => assertOk({ code: 40003, msg: 'forbidden' })).toThrow('40003');
  });
});

describe('createLarkClient', () => {
  it('returns a Lark Client instance', () => {
    const client = createLarkClient('app-id', 'app-secret');
    expect(client).toBeDefined();
  });
});
