import { defineConfig, devices } from '@playwright/test';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@127.0.0.1:5432/trade_the_pool';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const webPort = process.env.E2E_WEB_PORT ?? '3100';
const apiPort = process.env.E2E_API_PORT ?? '4100';
const webUrl = `http://127.0.0.1:${webPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `NODE_ENV=development API_HOST=127.0.0.1 API_PORT=${apiPort} DATABASE_URL=${databaseUrl} REDIS_URL=${redisUrl} DEV_AUTH_ENABLED=true API_DOCS_ENABLED=false TRUST_PROXY=false CORS_ALLOWED_ORIGINS=${webUrl} SESSION_TTL_SECONDS=604800 WALLET_AUTH_ENABLED=true SOLANA_CLUSTER=devnet WALLET_AUTH_ORIGIN=${webUrl} WALLET_AUTH_DOMAIN=127.0.0.1:${webPort} WALLET_CHALLENGE_TTL_SECONDS=300 MARKET_DATA_MODE=fake LOG_LEVEL=warn pnpm --filter @trade-the-pool/api exec tsx src/server.ts`,
      cwd: '../..',
      url: `${apiUrl}/health/ready`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `NEXT_PUBLIC_API_URL=${apiUrl} pnpm --filter @trade-the-pool/web dev --port ${webPort}`,
      cwd: '../..',
      url: webUrl,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /browser-smoke\.spec\.ts/,
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: /browser-smoke\.spec\.ts/ },
  ],
});
