import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withToken } from './feishu-doc-server.js';
import { NeedAuthorizationError } from '../auth/token-store.js';

// Mock dependencies
vi.mock('../auth/token-store.js', () => ({
  getValidAccessToken: vi.fn(),
  NeedAuthorizationError: class NeedAuthorizationError extends Error {
    userId: string;
    constructor(userId: string) {
      super(`User ${userId} needs authorization`);
      this.name = 'NeedAuthorizationError';
      this.userId = userId;
    }
  },
}));

vi.mock('./feishu-mcp.js', () => ({
  callFeishuMcp: vi.fn(),
}));

// We cannot easily test createFeishuDocServer because createSdkMcpServer
// requires the full Agent SDK runtime. We test the withToken wrapper instead,
// which contains all the important logic.

const { getValidAccessToken } = await import('../auth/token-store.js');
const mockGetValidAccessToken = vi.mocked(getValidAccessToken);

const fakeDb = {} as any;

describe('withToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes token to action and returns result on success', async () => {
    mockGetValidAccessToken.mockResolvedValue('u-valid-token');

    const expectedResult = {
      content: [{ type: 'text' as const, text: '{"doc_id":"abc"}' }],
    };

    const action = vi.fn().mockResolvedValue(expectedResult);

    const result = await withToken(fakeDb, 'user1', 'app1', 'secret1', action);

    expect(mockGetValidAccessToken).toHaveBeenCalledWith(fakeDb, 'user1', 'app1', 'secret1');
    expect(action).toHaveBeenCalledWith('u-valid-token');
    expect(result).toEqual(expectedResult);
  });

  it('returns need_authorization error when NeedAuthorizationError is thrown', async () => {
    const { NeedAuthorizationError: MockNeedAuth } = await import('../auth/token-store.js');
    mockGetValidAccessToken.mockRejectedValue(new MockNeedAuth('user1'));

    const action = vi.fn();

    const result = await withToken(fakeDb, 'user1', 'app1', 'secret1', action);

    expect(action).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(parsed.error).toBe('need_authorization');
    expect(parsed.message).toContain('auth');
  });

  it('re-throws non-authorization errors', async () => {
    mockGetValidAccessToken.mockRejectedValue(new Error('network failure'));

    const action = vi.fn();

    await expect(
      withToken(fakeDb, 'user1', 'app1', 'secret1', action),
    ).rejects.toThrow('network failure');
  });
});

describe('createFeishuDocServer', () => {
  it('smoke test — module exports createFeishuDocServer', async () => {
    const mod = await import('./feishu-doc-server.js');
    expect(typeof mod.createFeishuDocServer).toBe('function');
  });
});
