import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database, OAuthToken } from '../session/db.js';
import { getValidAccessToken, NeedAuthorizationError } from './token-store.js';
import { existsSync, unlinkSync } from 'fs';

const TEST_DB = '/tmp/remote-control-token-store-test.db';

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'u-valid-token',
    refreshToken: 'ur-refresh-token',
    expiresAt: Date.now() + 3600_000,       // 1h from now
    refreshExpiresAt: Date.now() + 86400_000, // 24h from now
    scope: 'docs:doc:readonly',
    grantedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function mockFetchSuccess(accessToken = 'u-new-access-token') {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      code: 0,
      access_token: accessToken,
      refresh_token: 'ur-new-refresh-token',
      expires_in: 7200,
      refresh_token_expires_in: 2592000,
      scope: 'docs:doc:readonly',
    }),
  });
}

describe('token-store', () => {
  let db: Database;
  const userId = 'ou_test_user';
  const appId = 'cli_test_app';
  const appSecret = 'test_secret';

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    vi.restoreAllMocks();
  });

  it('returns accessToken when token is still valid', async () => {
    const token = makeToken();
    db.saveToken(userId, token);

    const result = await getValidAccessToken(db, userId, appId, appSecret);
    expect(result).toBe(token.accessToken);
  });

  it('refreshes expired token and returns new accessToken', async () => {
    // Token expired (expiresAt in the past), but refresh token still valid
    const token = makeToken({
      expiresAt: Date.now() - 1000,
    });
    db.saveToken(userId, token);

    const fetchMock = mockFetchSuccess();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getValidAccessToken(db, userId, appId, appSecret);
    expect(result).toBe('u-new-access-token');
    expect(fetchMock).toHaveBeenCalledOnce();

    // DB should be updated
    const stored = db.getToken(userId)!;
    expect(stored.accessToken).toBe('u-new-access-token');
    expect(stored.refreshToken).toBe('ur-new-refresh-token');
  });

  it('throws NeedAuthorizationError when no token exists', async () => {
    await expect(
      getValidAccessToken(db, userId, appId, appSecret),
    ).rejects.toThrow(NeedAuthorizationError);

    try {
      await getValidAccessToken(db, userId, appId, appSecret);
    } catch (e) {
      expect(e).toBeInstanceOf(NeedAuthorizationError);
      expect((e as NeedAuthorizationError).userId).toBe(userId);
    }
  });

  it('deletes token and throws when refresh_token is expired', async () => {
    const token = makeToken({
      expiresAt: Date.now() - 1000,
      refreshExpiresAt: Date.now() - 1000,
    });
    db.saveToken(userId, token);

    await expect(
      getValidAccessToken(db, userId, appId, appSecret),
    ).rejects.toThrow(NeedAuthorizationError);

    // Token should be deleted from DB
    expect(db.getToken(userId)).toBeNull();
  });

  it('retries once on transient error (code 20050)', async () => {
    const token = makeToken({
      expiresAt: Date.now() - 1000,
    });
    db.saveToken(userId, token);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ code: 20050, msg: 'transient error' }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          access_token: 'u-retried-token',
          refresh_token: 'ur-retried-refresh',
          expires_in: 7200,
          scope: 'docs:doc:readonly',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getValidAccessToken(db, userId, appId, appSecret);
    expect(result).toBe('u-retried-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
