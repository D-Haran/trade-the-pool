import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';
import { databaseUrl } from './database';
import { E2E } from './fixtures';

const apiUrl = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '4000'}`;
let context: BrowserContext;
let page: Page;
let firstEntryId = '';
let secondEntryId = '';

test.describe.serial('authoritative trading journey', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
  });

  test.afterAll(async () => context?.close());

  test('development login persists and logout works', async () => {
    await page.goto('/login');
    await expect(page.getByText('Development only')).toBeVisible();
    await page.getByRole('button', { name: /E2E Trader/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.reload();
    await expect(page.getByText('E2E Trader')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/login');
    await page.getByRole('button', { name: /E2E Trader/ }).click();
  });

  test('creates an entry with the authoritative bankroll and pool increment', async () => {
    await page.goto(`/tournaments/${E2E.slug}`);
    await expect(page.getByText('Prize pool', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('$0.00').first()).toBeVisible();
    await expect(page.getByText('Base bankroll', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Enter now with', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create entry' }).click();
    await expect(page.getByText('Entry #1 created')).toBeVisible();
    await expect(page.locator('.entry-confirmation')).toContainText('Locked starting bankroll');
    await expect(page.locator('.entry-confirmation')).toContainText('$10,000.00');
    await expect(page.locator('.entry-confirmation')).toContainText('Current prize pool $25.00');
    const href = await page.getByRole('link', { name: /Open terminal/ }).getAttribute('href');
    firstEntryId = href!.split('/').at(-1)!;
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect(page.getByRole('combobox', { name: 'Active tournament entry' })).toHaveValue(
      firstEntryId,
    );
  });

  test('buys, marks the account through realtime, and sells the position', async () => {
    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'BTC-USD', price: '100000.00' },
    });
    await page.getByLabel('Buy notional in USD').fill('1000.00');
    await page.getByRole('button', { name: 'Buy BTC' }).click();
    await expect(page.getByText(/Bought .* BTC/).first()).toBeVisible();
    await expect(page.getByText('BTC/USD').last()).toBeVisible();

    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'BTC-USD', price: '110000.00' },
    });
    await expect(page.locator('.rank-score .positive').first()).toBeVisible();

    await page.getByRole('button', { name: 'Sell' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Sell BTC' }).click();
    await expect(page.getByText(/Sold .* BTC/).first()).toBeVisible();
    await page.getByRole('button', { name: /Orders/ }).click();
    await expect(page.locator('.orders-table .data-table__row')).toHaveCount(2);
  });

  test('keeps multiple entries isolated during active-entry switching', async () => {
    await page.goto(`/tournaments/${E2E.slug}`);
    await page.getByRole('button', { name: 'Create entry' }).click();
    await expect(page.getByText('Entry #2 created')).toBeVisible();
    const href = await page.getByRole('link', { name: /Open terminal/ }).getAttribute('href');
    secondEntryId = href!.split('/').at(-1)!;
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect(page.getByText('No open positions')).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Active tournament entry' })
      .selectOption(firstEntryId);
    await expect(page).toHaveURL(new RegExp(firstEntryId));
    await page.getByRole('button', { name: /Orders/ }).click();
    await expect(page.locator('.orders-table .data-table__row')).toHaveCount(2);
    await page
      .getByRole('combobox', { name: 'Active tournament entry' })
      .selectOption(secondEntryId);
    await expect(page).toHaveURL(new RegExp(secondEntryId));
    await page.getByRole('button', { name: /Orders/ }).click();
    await expect(page.getByText('No order history')).toBeVisible();
  });

  test('blocks access to another user private entry', async () => {
    const rival = await request.newContext({ baseURL: apiUrl });
    await rival.post('/v1/auth/dev/login', { data: { userId: E2E.otherUserId } });
    const created = await rival.post(`/v1/tournaments/${E2E.tournamentId}/entries`, { data: {} });
    const otherEntryId = ((await created.json()) as { data: { id: string } }).data.id;
    await rival.dispose();
    await page.goto(`/tournaments/${E2E.slug}/trade/${otherEntryId}`);
    await expect(page.getByText('Private entry unavailable')).toBeVisible();
  });

  test('disables trading at the authoritative tournament close', async () => {
    const sql = postgres(databaseUrl);
    await sql`UPDATE tournaments SET trading_closes_at = now() - interval '1 second' WHERE id = ${E2E.tournamentId}`;
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    const response = await page.request.post(`${apiUrl}/v1/orders`, {
      headers: { 'Idempotency-Key': 'e2e-closed-order' },
      data: { entryId: firstEntryId, symbol: 'BTC-USD', side: 'BUY', notional: '1.00' },
    });
    expect(response.status()).toBe(409);
    await sql`UPDATE tournaments SET trading_closes_at = now() + interval '2 days' WHERE id = ${E2E.tournamentId}`;
    await sql.end();
  });

  test('recovers and resynchronizes after a network reconnect', async () => {
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText(/Realtime connection degraded|reconnect/i).first()).toBeVisible();
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  });

  test('captures high-value desktop and mobile layouts', async ({ browserName }) => {
    test.skip(browserName !== 'chromium');
    await page.goto('/tournaments');
    await expect(page).toHaveScreenshot('tournaments-desktop.png', {
      fullPage: true,
      mask: [page.locator('.tournament-card__meta .tabular')],
      maskColor: '#0b1014',
    });
    await page.goto(`/tournaments/${E2E.slug}`);
    await expect(page).toHaveScreenshot('tournament-detail-desktop.png', {
      fullPage: true,
      mask: [page.locator('.entry-panel__deadline .tabular'), page.locator('.entry-panel__times')],
      maskColor: '#0b1014',
    });
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    const terminalMask = [
      page.locator('.market-chart'),
      page.locator('.terminal-deadline .tabular'),
    ];
    await expect(page).toHaveScreenshot('terminal-desktop.png', {
      fullPage: true,
      mask: terminalMask,
      maskColor: '#0b1014',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page).toHaveScreenshot('terminal-mobile.png', {
      fullPage: true,
      mask: terminalMask,
      maskColor: '#0b1014',
    });
  });
});
