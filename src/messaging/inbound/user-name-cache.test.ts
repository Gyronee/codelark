import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveUserName, clearUserNameCache } from './user-name-cache.js';

vi.mock('../outbound/send.js', () => ({
  getClient: vi.fn(),
}));

import { getClient } from '../outbound/send.js';

const mockGetClient = vi.mocked(getClient);

function makeClient(name: string) {
  return {
    contact: {
      v3: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name } } }),
        },
      },
    },
  };
}

describe('resolveUserName', () => {
  beforeEach(() => {
    clearUserNameCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearUserNameCache();
  });

  it('returns name from API', async () => {
    const mockClient = makeClient('Alice');
    mockGetClient.mockReturnValue(mockClient as any);

    const result = await resolveUserName('ou_abc123');
    expect(result).toBe('Alice');
    expect(mockClient.contact.v3.user.get).toHaveBeenCalledOnce();
  });

  it('returns cached name on second call without hitting API again', async () => {
    const mockClient = makeClient('Bob');
    mockGetClient.mockReturnValue(mockClient as any);

    await resolveUserName('ou_bob456');
    const result = await resolveUserName('ou_bob456');
    expect(result).toBe('Bob');
    expect(mockClient.contact.v3.user.get).toHaveBeenCalledOnce();
  });

  it('returns empty string and caches on API error', async () => {
    const mockClient = {
      contact: {
        v3: {
          user: {
            get: vi.fn().mockRejectedValue(new Error('network error')),
          },
        },
      },
    };
    mockGetClient.mockReturnValue(mockClient as any);

    const result = await resolveUserName('ou_err789');
    expect(result).toBe('');

    // Second call should use cache, not hit API again
    const result2 = await resolveUserName('ou_err789');
    expect(result2).toBe('');
    expect(mockClient.contact.v3.user.get).toHaveBeenCalledOnce();
  });
});

describe('clearUserNameCache', () => {
  it('clears the cache so next call hits the API again', async () => {
    const mockClient = makeClient('Carol');
    mockGetClient.mockReturnValue(mockClient as any);

    await resolveUserName('ou_carol');
    expect(mockClient.contact.v3.user.get).toHaveBeenCalledOnce();

    clearUserNameCache();

    await resolveUserName('ou_carol');
    expect(mockClient.contact.v3.user.get).toHaveBeenCalledTimes(2);
  });
});
