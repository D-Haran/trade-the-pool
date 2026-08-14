import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError, isAuthoritativeAuthenticationFailure } from './api-client';
import { isWebSocketAuthenticationFailure } from './realtime-client';
import { isSessionCheckUnavailable, shouldRedirectToLogin } from './session-state';

function response(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: code, requestId: 'request-test' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('frontend authentication failure boundaries', () => {
  it('turns only an authoritative 401 session response into unauthenticated state', async () => {
    const browserWindow = new EventTarget();
    let expirations = 0;
    browserWindow.addEventListener('ttp:session-expired', () => (expirations += 1));
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(response(401, 'AUTHENTICATION_REQUIRED'))),
    );
    await expect(api.session()).resolves.toBeNull();
    expect(expirations).toBe(0);
    await expect(api.entries()).rejects.toMatchObject({ status: 401 });
    expect(expirations).toBe(1);
    expect(
      isAuthoritativeAuthenticationFailure(
        new ApiClientError(401, 'AUTHENTICATION_REQUIRED', 'expired'),
      ),
    ).toBe(true);
  });

  it('keeps API 500 and offline failures distinct from logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(500, 'INTERNAL_ERROR')));
    await expect(api.session()).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(api.session()).rejects.toMatchObject({
      status: 0,
      code: 'BACKEND_UNAVAILABLE',
    });
  });

  it('redirects only after a successful null session check', () => {
    expect(shouldRedirectToLogin(true, null)).toBe(true);
    expect(shouldRedirectToLogin(false, undefined)).toBe(false);
    expect(isSessionCheckUnavailable(true, undefined)).toBe(true);
    expect(isSessionCheckUnavailable(false, null)).toBe(false);
  });

  it('does not treat WebSocket reconnect or auth-service unavailability as logout', () => {
    expect(isWebSocketAuthenticationFailure({ type: 'connection.ready' })).toBe(false);
    expect(
      isWebSocketAuthenticationFailure({ error: { code: 'AUTHENTICATION_UNAVAILABLE' } }),
    ).toBe(false);
    expect(isWebSocketAuthenticationFailure({ error: { code: 'AUTHENTICATION_REQUIRED' } })).toBe(
      true,
    );
  });
});
