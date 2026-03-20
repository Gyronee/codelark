import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestDeviceAuthorization, pollDeviceToken } from './device-flow.js';

// ---------------------------------------------------------------------------
// Mock global.fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// requestDeviceAuthorization
// ---------------------------------------------------------------------------

describe('requestDeviceAuthorization', () => {
  it('sends correct URL, headers, and body; parses response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'dev123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://example.com/activate',
        verification_uri_complete: 'https://example.com/activate?code=ABCD-1234',
        expires_in: 300,
        interval: 5,
      }),
    );

    const result = await requestDeviceAuthorization('app_id', 'app_secret', 'user:read offline_access');

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://accounts.feishu.cn/oauth/v1/device_authorization');
    expect(init?.method).toBe('POST');

    // Check Basic auth header
    const expectedAuth = 'Basic ' + Buffer.from('app_id:app_secret').toString('base64');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: expectedAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    );

    // Check body params
    const params = new URLSearchParams(init?.body as string);
    expect(params.get('client_id')).toBe('app_id');
    expect(params.get('scope')).toBe('user:read offline_access');

    // Check parsed response
    expect(result).toEqual({
      deviceCode: 'dev123',
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.com/activate',
      verificationUriComplete: 'https://example.com/activate?code=ABCD-1234',
      expiresIn: 300,
      interval: 5,
    });
  });

  it('auto-appends offline_access to scope when not present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'dev456',
        user_code: 'WXYZ-9999',
        verification_uri: 'https://example.com/activate',
        expires_in: 240,
        interval: 5,
      }),
    );

    await requestDeviceAuthorization('app_id', 'app_secret', 'user:read');

    const [, init] = mockFetch.mock.calls[0];
    const params = new URLSearchParams(init?.body as string);
    expect(params.get('scope')).toBe('user:read offline_access');
  });
});

// ---------------------------------------------------------------------------
// pollDeviceToken
// ---------------------------------------------------------------------------

describe('pollDeviceToken', () => {
  it('returns success token on first try', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'at_xxx',
        refresh_token: 'rt_xxx',
        expires_in: 7200,
        refresh_token_expires_in: 604800,
        scope: 'user:read',
      }),
    );

    const result = await pollDeviceToken({
      appId: 'app_id',
      appSecret: 'app_secret',
      deviceCode: 'dev123',
      expiresIn: 300,
      interval: 0, // no wait in tests
    });

    expect(result).toEqual({
      ok: true,
      token: {
        accessToken: 'at_xxx',
        refreshToken: 'rt_xxx',
        expiresIn: 7200,
        refreshExpiresIn: 604800,
        scope: 'user:read',
      },
    });

    // Verify token endpoint was called correctly
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token');
    const params = new URLSearchParams(init?.body as string);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(params.get('device_code')).toBe('dev123');
    expect(params.get('client_id')).toBe('app_id');
    expect(params.get('client_secret')).toBe('app_secret');
  });

  it('handles authorization_pending then success', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'at_delayed',
          refresh_token: 'rt_delayed',
          expires_in: 3600,
          refresh_token_expires_in: 86400,
          scope: 'user:read',
        }),
      );

    const result = await pollDeviceToken({
      appId: 'app_id',
      appSecret: 'app_secret',
      deviceCode: 'dev789',
      expiresIn: 300,
      interval: 0,
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      token: {
        accessToken: 'at_delayed',
        refreshToken: 'rt_delayed',
        expiresIn: 3600,
        refreshExpiresIn: 86400,
        scope: 'user:read',
      },
    });
  });

  it('handles access_denied', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }));

    const result = await pollDeviceToken({
      appId: 'app_id',
      appSecret: 'app_secret',
      deviceCode: 'dev_denied',
      expiresIn: 300,
      interval: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: 'access_denied',
      message: 'User denied authorization',
    });
  });

  it('handles slow_down by increasing interval', async () => {
    vi.useFakeTimers();

    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'at_slow',
          refresh_token: 'rt_slow',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: '',
        }),
      );

    const promise = pollDeviceToken({
      appId: 'app_id',
      appSecret: 'app_secret',
      deviceCode: 'dev_slow',
      expiresIn: 300,
      interval: 1, // starts at 1s, after slow_down becomes 6s
    });

    // First sleep: 1s (initial interval)
    await vi.advanceTimersByTimeAsync(1000);
    // After slow_down, interval becomes 1+5=6. Second sleep: 6s
    await vi.advanceTimersByTimeAsync(6000);

    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      ok: true,
      token: {
        accessToken: 'at_slow',
        refreshToken: 'rt_slow',
        expiresIn: 7200,
        refreshExpiresIn: 604800,
        scope: '',
      },
    });

    vi.useRealTimers();
  });
});
