import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { MemoryKeyValueStore, RateLimiter } from './infrastructure.js';

const app = await buildApp();

describe('health endpoint', () => {
  it('returns a healthy response and request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-request' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', requestId: 'test-request' });
  });
});

afterAll(() => app.close());

describe('centralized rate limiting', () => {
  it('enforces a fixed-window policy', async () => {
    const limiter = new RateLimiter(new MemoryKeyValueStore());
    await limiter.consume('test', 'subject', { limit: 2, windowSeconds: 60 });
    await limiter.consume('test', 'subject', { limit: 2, windowSeconds: 60 });
    await expect(
      limiter.consume('test', 'subject', { limit: 2, windowSeconds: 60 }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });
});
