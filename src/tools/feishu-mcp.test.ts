import { describe, it, expect, vi, afterEach } from 'vitest';
import { callFeishuMcp, unwrapResult } from './feishu-mcp.js';

function makeFetchMock(options: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body: unknown;
}) {
  return vi.fn().mockResolvedValue({
    ok: options.ok,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    text: async () =>
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('callFeishuMcp', () => {
  it('success — returns parsed result content', async () => {
    const resultContent = { type: 'text', text: 'Hello from MCP' };
    const mockFetch = makeFetchMock({
      ok: true,
      body: {
        jsonrpc: '2.0',
        id: 'test-tool-123',
        result: resultContent,
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callFeishuMcp('test-tool', { param: 'value' }, 'u-token-123');

    expect(result).toEqual(resultContent);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mcp.feishu.cn/mcp');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Lark-MCP-UAT']).toBe('u-token-123');
    expect(init.headers['X-Lark-MCP-Allowed-Tools']).toBe('test-tool');

    const sentBody = JSON.parse(init.body);
    expect(sentBody.jsonrpc).toBe('2.0');
    expect(sentBody.method).toBe('tools/call');
    expect(sentBody.params.name).toBe('test-tool');
    expect(sentBody.params.arguments).toEqual({ param: 'value' });
  });

  it('JSON-RPC error — throws with error message', async () => {
    const mockFetch = makeFetchMock({
      ok: true,
      body: {
        jsonrpc: '2.0',
        id: 'test-tool-123',
        error: {
          code: -32601,
          message: 'Method not found',
        },
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      callFeishuMcp('unknown-tool', {}, 'u-token-123'),
    ).rejects.toThrow('Method not found');
  });

  it('HTTP error (500) — throws with status', async () => {
    const mockFetch = makeFetchMock({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      callFeishuMcp('some-tool', {}, 'u-token-123'),
    ).rejects.toThrow('MCP HTTP 500');
  });

  it('nested result — unwraps correctly', async () => {
    const innerContent = { key: 'value' };
    // Double-wrapped result: result contains another JSON-RPC envelope
    const mockFetch = makeFetchMock({
      ok: true,
      body: {
        jsonrpc: '2.0',
        id: 'test-tool-123',
        result: {
          jsonrpc: '2.0',
          result: innerContent,
        },
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callFeishuMcp('nested-tool', {}, 'u-token-456');
    expect(result).toEqual(innerContent);
  });
});

describe('unwrapResult', () => {
  it('returns primitive values as-is', () => {
    expect(unwrapResult(42)).toBe(42);
    expect(unwrapResult('hello')).toBe('hello');
    expect(unwrapResult(null)).toBe(null);
  });

  it('unwraps jsonrpc + result envelope', () => {
    const inner = { data: 'test' };
    expect(unwrapResult({ jsonrpc: '2.0', id: '1', result: inner })).toEqual(inner);
  });

  it('throws on jsonrpc + error envelope', () => {
    expect(() =>
      unwrapResult({ jsonrpc: '2.0', id: '1', error: { code: -1, message: 'oops' } }),
    ).toThrow('oops');
  });

  it('unwraps result-only envelope (no jsonrpc)', () => {
    const inner = { data: 'value' };
    expect(unwrapResult({ result: inner })).toEqual(inner);
  });

  it('returns plain object without result/jsonrpc as-is', () => {
    const plain = { foo: 'bar' };
    expect(unwrapResult(plain)).toEqual(plain);
  });

  it('recursively unwraps nested envelopes', () => {
    const leaf = { leaf: true };
    const nested = {
      jsonrpc: '2.0',
      result: {
        jsonrpc: '2.0',
        result: leaf,
      },
    };
    expect(unwrapResult(nested)).toEqual(leaf);
  });
});
