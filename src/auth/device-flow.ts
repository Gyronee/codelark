/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for Feishu.
 *
 * Two-step flow:
 *   1. `requestDeviceAuthorization` – obtains device_code + user_code.
 *   2. `pollDeviceToken` – polls the token endpoint until the user authorises,
 *      rejects, or the code expires.
 */

import { logger } from '../logger.js';

const log = logger.child({ module: 'auth/device-flow' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  scope: string;
}

export type TokenResult =
  | { ok: true; token: TokenData }
  | { ok: false; error: string; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Step 1 – Device Authorization Request
// ---------------------------------------------------------------------------

const DEVICE_AUTH_URL = 'https://accounts.feishu.cn/oauth/v1/device_authorization';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';

/**
 * Request a device authorisation code from the Feishu OAuth server.
 *
 * Uses Confidential Client authentication (HTTP Basic with appId:appSecret).
 * The `offline_access` scope is automatically appended so that the token
 * response includes a refresh_token.
 */
export async function requestDeviceAuthorization(
  appId: string,
  appSecret: string,
  scope: string,
): Promise<DeviceAuthResponse> {
  // Ensure offline_access is always requested.
  if (!scope.includes('offline_access')) {
    scope = scope ? `${scope} offline_access` : 'offline_access';
  }

  const basicAuth = Buffer.from(`${appId}:${appSecret}`).toString('base64');

  const body = new URLSearchParams();
  body.set('client_id', appId);
  body.set('scope', scope);

  log.info(`requesting device authorization (scope="${scope}")`);

  const resp = await fetch(DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  const text = await resp.text();
  log.info({ status: resp.status }, 'device authorization response');

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Device authorization failed: HTTP ${resp.status} – ${text.slice(0, 200)}`);
  }

  if (!resp.ok || data.error) {
    const msg = (data.error_description as string) ?? (data.error as string) ?? 'Unknown error';
    throw new Error(`Device authorization failed: ${msg}`);
  }

  const expiresIn = (data.expires_in as number) ?? 240;
  const interval = (data.interval as number) ?? 5;

  return {
    deviceCode: data.device_code as string,
    userCode: data.user_code as string,
    verificationUri: data.verification_uri as string,
    verificationUriComplete: (data.verification_uri_complete as string) ?? (data.verification_uri as string),
    expiresIn,
    interval,
  };
}

// ---------------------------------------------------------------------------
// Step 2 – Poll Token Endpoint
// ---------------------------------------------------------------------------

export interface PollDeviceTokenParams {
  appId: string;
  appSecret: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  signal?: AbortSignal;
}

/**
 * Poll the token endpoint until the user authorises, rejects, or the code
 * expires.
 *
 * Handles `authorization_pending` (keep polling), `slow_down` (back off by
 * +5 s), `access_denied` and `expired_token` (terminal errors).
 */
export async function pollDeviceToken(params: PollDeviceTokenParams): Promise<TokenResult> {
  const MAX_POLL_INTERVAL = 60;
  const MAX_POLL_ATTEMPTS = 200;

  const { appId, appSecret, deviceCode, expiresIn, signal } = params;
  let interval = params.interval;

  const deadline = Date.now() + expiresIn * 1000;
  let attempts = 0;

  while (Date.now() < deadline && attempts < MAX_POLL_ATTEMPTS) {
    attempts++;

    if (signal?.aborted) {
      return { ok: false, error: 'expired_token', message: 'Polling was cancelled' };
    }

    await sleep(interval * 1000, signal);

    let data: Record<string, unknown>;
    try {
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: appId,
          client_secret: appSecret,
        }).toString(),
      });
      data = (await resp.json()) as Record<string, unknown>;
    } catch (err) {
      log.warn({ err }, 'poll network error');
      interval = Math.min(interval + 1, MAX_POLL_INTERVAL);
      continue;
    }

    const error = data.error as string | undefined;

    if (!error && data.access_token) {
      log.info('token obtained successfully');
      const refreshToken = (data.refresh_token as string) ?? '';
      const tokenExpiresIn = (data.expires_in as number) ?? 7200;
      let refreshExpiresIn = (data.refresh_token_expires_in as number) ?? 604800;
      if (!refreshToken) {
        refreshExpiresIn = tokenExpiresIn;
      }
      return {
        ok: true,
        token: {
          accessToken: data.access_token as string,
          refreshToken,
          expiresIn: tokenExpiresIn,
          refreshExpiresIn,
          scope: (data.scope as string) ?? '',
        },
      };
    }

    if (error === 'authorization_pending') {
      log.debug('authorization_pending, retrying...');
      continue;
    }

    if (error === 'slow_down') {
      interval = Math.min(interval + 5, MAX_POLL_INTERVAL);
      log.info({ interval }, 'slow_down, interval increased');
      continue;
    }

    if (error === 'access_denied') {
      log.info('user denied authorization');
      return { ok: false, error: 'access_denied', message: 'User denied authorization' };
    }

    if (error === 'expired_token' || error === 'invalid_grant') {
      log.info({ error }, 'device code expired/invalid');
      return { ok: false, error: 'expired_token', message: 'Device code expired' };
    }

    // Unknown error – treat as terminal.
    const desc = (data.error_description as string) ?? error ?? 'Unknown error';
    log.warn({ error, desc }, 'unexpected error');
    return { ok: false, error: 'expired_token', message: desc };
  }

  return { ok: false, error: 'expired_token', message: 'Authorization timed out' };
}
