import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users, type Database } from '@trade-the-pool/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyValueStore } from './infrastructure.js';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'ttp_session';

export type AuthenticatedUser = { id: string; displayName: string };
type Session = { userId: string; expiresAt: string };

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | null;
  }
}

export class AuthenticationService {
  constructor(
    private readonly db: Database,
    private readonly store: KeyValueStore,
    private readonly ttlSeconds: number,
  ) {}

  async createSession(userId: string): Promise<{ id: string; user: AuthenticatedUser }> {
    const [user] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Development user does not exist.');
    const id = randomBytes(32).toString('base64url');
    const session: Session = {
      userId,
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
    };
    await this.store.set(`session:${id}`, JSON.stringify(session), this.ttlSeconds);
    return { id, user };
  }

  async resolveSession(id: string | undefined): Promise<AuthenticatedUser | null> {
    if (!id) return null;
    const raw = await this.store.get(`session:${id}`);
    if (!raw) return null;
    let session: Session;
    try {
      session = JSON.parse(raw) as Session;
    } catch {
      await this.store.delete(`session:${id}`);
      return null;
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.store.delete(`session:${id}`);
      return null;
    }
    const [user] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, session.userId));
    return user ?? null;
  }

  async invalidate(id: string | undefined): Promise<void> {
    if (id) await this.store.delete(`session:${id}`);
  }
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.authenticatedUser)
    throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  return request.authenticatedUser;
}

export function setSessionCookie(
  reply: FastifyReply,
  id: string,
  production: boolean,
  ttlSeconds: number,
): void {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    maxAge: ttlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, production: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
  });
}
