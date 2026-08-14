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

describe('development authentication isolation', () => {
  it('fails before registering any route when production enables development login', async () => {
    await expect(
      buildApp({
        db: null as never,
        market: null as never,
        store: new MemoryKeyValueStore(),
        config: {
          NODE_ENV: 'production',
          DEV_AUTH_ENABLED: true,
          API_DOCS_ENABLED: false,
          TRUST_PROXY: false,
          CORS_ALLOWED_ORIGINS: 'https://app.example.com',
          SESSION_TTL_SECONDS: 604_800,
          WALLET_AUTH_ENABLED: true,
          SOLANA_CLUSTER: 'mainnet-beta',
          WALLET_AUTH_ORIGIN: 'https://app.example.com',
          WALLET_AUTH_DOMAIN: 'app.example.com',
          WALLET_CHALLENGE_TTL_SECONDS: 300,
        },
      }),
    ).rejects.toThrow('Development authentication cannot be enabled in production');
  });
});
