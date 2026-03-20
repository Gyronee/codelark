import { Database, OAuthToken } from '../session/db.js';

/**
 * Thrown when the user has no valid token and must re-authorize.
 */
export class NeedAuthorizationError extends Error {
  public readonly userId: string;

  constructor(userId: string) {
    super(`User ${userId} needs authorization`);
    this.name = 'NeedAuthorizationError';
    this.userId = userId;
  }
}

// Per-user refresh lock to prevent concurrent refresh_token usage
const refreshLocks = new Map<string, Promise<OAuthToken | null>>();

const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const TRANSIENT_ERROR_CODE = 20050;

/**
 * Get a valid access token for a user, refreshing if needed.
 */
export async function getValidAccessToken(
  db: Database,
  userId: string,
  appId: string,
  appSecret: string,
): Promise<string> {
  const token = db.getToken(userId);
  if (!token) {
    throw new NeedAuthorizationError(userId);
  }

  // Token still valid (with 60s buffer)
  if (Date.now() < token.expiresAt - 60_000) {
    return token.accessToken;
  }

  // Refresh token expired — can't refresh
  if (Date.now() >= token.refreshExpiresAt) {
    db.deleteToken(userId);
    throw new NeedAuthorizationError(userId);
  }

  // Needs refresh
  const refreshed = await refreshWithLock(db, userId, appId, appSecret, token);
  if (!refreshed) {
    throw new NeedAuthorizationError(userId);
  }
  return refreshed.accessToken;
}

async function refreshWithLock(
  db: Database,
  userId: string,
  appId: string,
  appSecret: string,
  token: OAuthToken,
): Promise<OAuthToken | null> {
  const key = `${appId}:${userId}`;

  const existing = refreshLocks.get(key);
  if (existing) {
    await existing;
    // Re-read from DB after another refresh completed
    return db.getToken(userId);
  }

  const promise = doRefresh(db, userId, appId, appSecret, token);
  refreshLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(key);
  }
}

async function doRefresh(
  db: Database,
  userId: string,
  appId: string,
  appSecret: string,
  token: OAuthToken,
): Promise<OAuthToken | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: appId,
    client_secret: appSecret,
  }).toString();

  const callEndpoint = async () => {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return (await resp.json()) as {
      code?: number;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
    };
  };

  let data = await callEndpoint();

  const code = data.code;
  const error = data.error;

  if ((code !== undefined && code !== 0) || error) {
    // Transient error: retry once
    if (code === TRANSIENT_ERROR_CODE) {
      data = await callEndpoint();
      const retryCode = data.code;
      const retryError = data.error;
      if ((retryCode !== undefined && retryCode !== 0) || retryError) {
        db.deleteToken(userId);
        return null;
      }
    } else {
      db.deleteToken(userId);
      return null;
    }
  }

  const now = Date.now();
  const updated: OAuthToken = {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: now + (data.expires_in ?? 7200) * 1000,
    refreshExpiresAt: data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : token.refreshExpiresAt,
    scope: data.scope ?? token.scope,
    grantedAt: token.grantedAt,
  };

  db.saveToken(userId, updated);
  return updated;
}
