import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isGroupAdmin, clearGroupAdminCache } from './group-admin.js';

vi.mock('../messaging/outbound/send.js', () => ({
  getClient: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getClient } from '../messaging/outbound/send.js';

function makeMockClient(pages: Array<{ items: Array<{ member_id: string; member_type: string }>; page_token?: string }>) {
  let callCount = 0;
  const getMock = vi.fn(async () => {
    const page = pages[callCount] ?? { items: [] };
    callCount++;
    return { data: page };
  });
  return {
    im: { v1: { chatMembers: { get: getMock } } },
    _getMock: getMock,
  };
}

describe('isGroupAdmin', () => {
  beforeEach(() => {
    clearGroupAdminCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearGroupAdminCache();
  });

  // 1. User is owner → true
  it('returns true when user is the owner', async () => {
    const mockClient = makeMockClient([
      { items: [{ member_id: 'ou_owner', member_type: 'owner' }, { member_id: 'ou_regular', member_type: 'member' }] },
    ]);
    vi.mocked(getClient).mockReturnValue(mockClient as any);

    const result = await isGroupAdmin('chat_123', 'ou_owner');
    expect(result).toBe(true);
  });

  // 2. User is regular member → false
  it('returns false when user is a regular member', async () => {
    const mockClient = makeMockClient([
      { items: [{ member_id: 'ou_owner', member_type: 'owner' }, { member_id: 'ou_regular', member_type: 'member' }] },
    ]);
    vi.mocked(getClient).mockReturnValue(mockClient as any);

    const result = await isGroupAdmin('chat_123', 'ou_regular');
    expect(result).toBe(false);
  });

  // 3. Cache hit within 30 minutes → no API call
  it('uses cache and makes no API call on second invocation within TTL', async () => {
    const mockClient = makeMockClient([
      { items: [{ member_id: 'ou_owner', member_type: 'owner' }] },
    ]);
    vi.mocked(getClient).mockReturnValue(mockClient as any);

    // First call — populates cache
    await isGroupAdmin('chat_cache', 'ou_owner');
    expect(mockClient._getMock).toHaveBeenCalledTimes(1);

    // Second call — should hit cache, no additional API call
    const result = await isGroupAdmin('chat_cache', 'ou_owner');
    expect(result).toBe(true);
    expect(mockClient._getMock).toHaveBeenCalledTimes(1);
  });

  // 4. API failure → returns false
  it('returns false and logs a warning when API throws', async () => {
    const getMock = vi.fn(async () => { throw new Error('API error'); });
    const mockClient = { im: { v1: { chatMembers: { get: getMock } } } };
    vi.mocked(getClient).mockReturnValue(mockClient as any);

    const { logger } = await import('../logger.js');
    const result = await isGroupAdmin('chat_err', 'ou_anyone');

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat_err', userId: 'ou_anyone' }),
      'Failed to check group admin status',
    );
  });
});
