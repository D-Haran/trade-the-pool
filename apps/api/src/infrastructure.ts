import { createClient } from 'redis';
import { ApiError } from './errors.js';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class RedisKeyValueStore implements KeyValueStore {
  readonly client;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async connect(): Promise<void> {
    this.client.on('error', () => undefined);
    await this.client.connect();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.client.set(key, value, { EX: ttlSeconds });
    else await this.client.set(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.client.incr(key);
    if (value === 1) await this.client.expire(key, ttlSeconds);
    return value;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}

type MemoryValue = { value: string; expiresAt: number | null };

export class MemoryKeyValueStore implements KeyValueStore {
  readonly values = new Map<string, MemoryValue>();

  async get(key: string): Promise<string | null> {
    const record = this.values.get(key);
    if (!record) return null;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return record.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const next = Number((await this.get(key)) ?? '0') + 1;
    await this.set(key, String(next), ttlSeconds);
    return next;
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

export type RateLimitPolicy = { limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  auth: { limit: 10, windowSeconds: 60 },
  entryCreation: { limit: 10, windowSeconds: 60 },
  orderSubmission: { limit: 120, windowSeconds: 60 },
  websocketConnections: { limit: 20, windowSeconds: 60 },
  websocketSubscriptions: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export class RateLimiter {
  constructor(private readonly store: KeyValueStore) {}

  async consume(scope: string, subject: string, policy: RateLimitPolicy): Promise<void> {
    const bucket = Math.floor(Date.now() / (policy.windowSeconds * 1000));
    const count = await this.store.increment(
      `rate:${scope}:${subject}:${bucket}`,
      policy.windowSeconds + 1,
    );
    if (count > policy.limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.', {
        retryAfterSeconds: policy.windowSeconds,
      });
    }
  }
}
