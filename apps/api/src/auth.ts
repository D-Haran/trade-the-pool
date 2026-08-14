import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users, type Database } from '@trade-the-pool/database';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KeyValueStore } from './infrastructure.js';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'ttp_session';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AuthenticatedUser = { id: string; displayName: string };
type Session = { version?: 1; userId: string; createdAt?: string; expiresAt: string };
export type AuthenticatedSession = {
  id: string;
  expiresAt: Date;
  user: AuthenticatedUser;
};

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | null;
    authenticatedSession: AuthenticatedSession | null;
  }
}

export function sessionKey(id: string): string {
  return `session:${id}`;
}

export class AuthenticationService {
  constructor(
    private readonly db: Database,
    private readonly store: KeyValueStore,
    private readonly ttlSeconds: number,
  ) {}

  async createSession(userId: string): Promise<AuthenticatedSession> {
    const [user] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'Development user does not exist.');
    const id = randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1000);
    const session: Session = {
      version: 1,
      userId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    try {
      await this.store.set(sessionKey(id), JSON.stringify(session), this.ttlSeconds);
    } catch {
      throw new ApiError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'The authentication service is temporarily unavailable.',
      );
    }
    return { id, expiresAt, user };
  }

  async rotateSession(
    userId: string,
    previousId: string | undefined,
  ): Promise<AuthenticatedSession> {
    const next = await this.createSession(userId);
    if (!previousId || !SESSION_ID_PATTERN.test(previousId) || previousId === next.id) return next;
    try {
      await this.store.delete(sessionKey(previousId));
    } catch {
      try {
        await this.store.delete(sessionKey(next.id));
      } catch {
        // The fixed expiry still bounds either identifier if Redis is failing during rollback.
      }
      throw new ApiError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'The authentication service is temporarily unavailable.',
      );
    }
    return next;
  }

  async resolveSession(id: string | undefined): Promise<AuthenticatedSession | null> {
    if (!id || !SESSION_ID_PATTERN.test(id)) return null;
    let raw: string | null;
    try {
      raw = await this.store.get(sessionKey(id));
    } catch {
      throw new ApiError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'The authentication service is temporarily unavailable.',
      );
    }
    if (!raw) return null;
    let session: Session;
    try {
      session = JSON.parse(raw) as Session;
    } catch {
      await this.deleteBestEffort(id);
      return null;
    }
    const expiresAt = new Date(session.expiresAt);
    if (
      typeof session.userId !== 'string' ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now()
    ) {
      await this.deleteBestEffort(id);
      return null;
    }
    const [user] = await this.db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, session.userId));
    if (!user) {
      await this.deleteBestEffort(id);
      return null;
    }
    return { id, expiresAt, user };
  }

  async invalidate(id: string | undefined): Promise<void> {
    if (!id || !SESSION_ID_PATTERN.test(id)) return;
    try {
      await this.store.delete(sessionKey(id));
    } catch {
      throw new ApiError(
        503,
        'AUTHENTICATION_UNAVAILABLE',
        'The authentication service is temporarily unavailable.',
      );
    }
  }

  private async deleteBestEffort(id: string): Promise<void> {
    try {
      await this.store.delete(sessionKey(id));
    } catch {
      // Invalid and expired identifiers remain unusable because their payload is checked every time.
    }
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
    priority: 'high',
  });
}

export function clearSessionCookie(reply: FastifyReply, production: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    priority: 'high',
  });
}
