import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { clearSessionCookie, setSessionCookie } from './auth.js';

describe('session cookie policy', () => {
  it('uses a host-only HttpOnly development cookie without weakening production', () => {
    const setCookie = vi.fn();
    setSessionCookie({ setCookie } as unknown as FastifyReply, 'opaque', false, 604_800);
    expect(setCookie).toHaveBeenCalledWith(
      'ttp_session',
      'opaque',
      expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 604_800,
        priority: 'high',
      }),
    );
    expect(setCookie.mock.calls[0][2]).not.toHaveProperty('domain');

    setSessionCookie({ setCookie } as unknown as FastifyReply, 'opaque', true, 604_800);
    expect(setCookie.mock.calls[1][2]).toMatchObject({ secure: true });
  });

  it('clears with the same security and scope attributes', () => {
    const clearCookie = vi.fn();
    clearSessionCookie({ clearCookie } as unknown as FastifyReply, true);
    expect(clearCookie).toHaveBeenCalledWith(
      'ttp_session',
      expect.objectContaining({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' }),
    );
  });
});
