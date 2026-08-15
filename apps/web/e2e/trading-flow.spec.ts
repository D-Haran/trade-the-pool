import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';
import { createClient } from 'redis';
import { databaseUrl, redisUrl } from './database';
import { E2E } from './fixtures';

const apiUrl = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '4100'}`;
let context: BrowserContext;
let page: Page;
let firstEntryId = '';
let secondEntryId = '';

async function selectMarket(label: string) {
  await page.locator('.market-selector-trigger').click();
  await page.locator('.market-picker button').filter({ hasText: label }).click();
  await expect(page.locator('.market-selector-trigger')).toContainText(label);
}

test.describe.serial('authoritative trading journey', () => {
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
  });

  test.afterAll(async () => context?.close());

  test('development login persists and logout works', async () => {
    await page.goto('/login');
    await expect(page.getByText('Local development access')).toBeVisible();
    await page.getByRole('button', { name: /E2E Trader/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.reload();
    await expect(page.getByText('E2E Trader')).toBeVisible();
    const sessionCookie = (await context.cookies(apiUrl)).find(
      (candidate) => candidate.name === 'ttp_session',
    );
    expect(sessionCookie).toMatchObject({
      name: 'ttp_session',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
      path: '/',
    });

    await page.route('**/v1/auth/me', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'temporary' } }),
      }),
    );
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Session check unavailable').first()).toBeVisible();
    await page.unroute('**/v1/auth/me');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
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
    await expect(page.getByText('Entry now', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.entry-panel')).toContainText('$30.00');
    await expect(page.locator('.payout-grid')).toContainText('1st Prize');
    await expect(page.locator('.payout-grid')).toContainText('$0.00');
    await page.getByRole('button', { name: 'Create entry' }).click();
    await expect(page.getByText('Entry #1 created')).toBeVisible();
    await expect(page.locator('.entry-confirmation')).toContainText('Locked starting bankroll');
    await expect(page.locator('.entry-confirmation')).toContainText('$10,000.00');
    await expect(page.locator('.entry-confirmation')).toContainText('Current prize pool $25.00');
    await expect(page.locator('.entry-confirmation')).toContainText('Entry price locked at $30.00');
    await expect(page.locator('.payout-grid')).toContainText('$12.50');
    const href = await page.getByRole('link', { name: /Open terminal/ }).getAttribute('href');
    firstEntryId = href!.split('/').at(-1)!;
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect(page.getByRole('combobox', { name: 'Active tournament entry' })).toHaveValue(
      firstEntryId,
    );
  });

  test('trades long and short, manages risk, and exercises chart and pending-order controls', async () => {
    await expect(page.locator('.market-activity-strip')).toContainText('WATCHLIST');
    await expect(page.locator('.market-activity-strip')).toContainText('MARKET PULSE');
    await expect(page.locator('.market-watchlist-scroll button')).toHaveCount(12);
    await page.locator('.market-selector-trigger').click();
    await expect(page.locator('.market-picker > button')).toHaveCount(12);
    await page.getByPlaceholder('Search markets').fill('Sui');
    await page.locator('.market-picker button').filter({ hasText: 'SUI/USD' }).click();
    await expect(page.locator('.market-selector-trigger')).toContainText('SUI/USD');
    await expect(page.getByRole('group', { name: 'Leverage' }).getByRole('button')).toHaveCount(2);

    await selectMarket('ETH/USD');
    await page.getByRole('group', { name: 'Leverage' }).getByRole('button', { name: '5x' }).click();
    await page.getByLabel('Margin amount in USD').fill('1000.00');
    await expect(page.locator('.position-size-preview')).toContainText('$5,000.00');
    await expect(page.locator('.position-size-preview')).toContainText('$1,000.00 margin');
    await page
      .getByRole('group', { name: 'Order sizing mode' })
      .getByRole('button', { name: 'Position Size' })
      .click();
    await page.getByLabel('Position size in USD').fill('5000.00');
    await expect(page.locator('.position-size-preview')).toContainText('$1,000.00 margin');
    await page
      .getByRole('group', { name: 'Order sizing mode' })
      .getByRole('button', { name: 'Margin' })
      .click();
    await page.getByLabel('Margin amount in USD').fill('1000.00');
    await page.getByRole('button', { name: /Take Profit \/ Stop Loss/ }).click();
    await page.getByLabel('TAKE PROFIT').fill('4200.00');
    await page.getByLabel('STOP LOSS').fill('3900.00');
    await page.getByRole('button', { name: 'Place LONG Order' }).click();
    await page.getByRole('button', { name: 'Confirm LONG ETH' }).click();
    await expect(page.getByText('LONG ETH FILLED')).toBeVisible();
    await expect(page.locator('.terminal-table--positions')).toContainText('ETH/USD');
    await expect(page.locator('.terminal-table--positions')).toContainText('LONG');
    await expect(page.locator('.terminal-table--positions')).toContainText('5x');
    await expect(page.locator('.terminal-table--positions')).toContainText('Liq. Estimate');
    await expect(page.locator('.account-metric--position')).toContainText('ETH/USD · LONG · 5x');
    await expect(page.locator('.tournament-pnl-metric')).toContainText('TOTAL P&L');
    await expect(page.getByText('TOTAL P&L', { exact: true })).toHaveCount(1);
    await expect(page.locator('.terminal-account-strip')).toContainText('ACCOUNT EXPOSURE');
    await expect(page.getByRole('tab', { name: 'ORDER' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'SELL' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trades', exact: true })).toBeVisible();
    await expect(page.locator('.mini-leaderboard')).toBeVisible();
    await expect(page.locator('.mini-leaderboard__row.is-current')).toContainText('YOU');
    await expect(page.getByText('PAPER', { exact: true }).first()).toBeVisible();

    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'ETH-USD', price: '4100.00' },
    });
    await expect(page.locator('.terminal-table--positions .positive').first()).toBeVisible();
    await expect(
      page.locator('.account-metric--position.positive, .account-metric--position .positive'),
    ).toBeVisible();
    await expect(page.locator('.tournament-pnl-metric dd')).toHaveClass(/positive/);

    await page
      .locator('.terminal-table--positions .terminal-table__row')
      .filter({ hasText: 'ETH/USD' })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByRole('tab', { name: 'SELL' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.sell-ticket')).toContainText('SELL TO CLOSE');
    await page
      .getByRole('group', { name: 'Position reduction' })
      .getByRole('button', { name: '25%' })
      .click();
    await page.getByRole('button', { name: 'Close 25% LONG Position' }).click();
    await page.getByRole('button', { name: 'Confirm 25% Close' }).click();
    await expect(page.getByText('LONG ETH FILLED')).toBeVisible();

    await selectMarket('BTC/USD');
    await page.getByRole('tab', { name: 'ORDER' }).click();
    await page.getByRole('button', { name: 'Limit', exact: true }).click();
    await page.getByLabel('Margin amount in USD').fill('500.00');
    await page.getByLabel('Limit price').fill('90000.00');
    await page.getByRole('button', { name: 'Create LONG order' }).click();
    await page.getByRole('button', { name: 'Confirm LONG BTC' }).click();
    await expect(page.getByText('LONG BTC/USD order open')).toBeVisible();
    await page.getByRole('button', { name: /Open Orders/ }).click();
    const limitRow = page
      .locator('.terminal-table--orders .terminal-table__row')
      .filter({ hasText: 'BTC/USD' });
    await expect(limitRow).toContainText('LIMIT');
    await limitRow.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Order cancelled')).toBeVisible();

    await expect(page.getByRole('button', { name: '1s', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '5s', exact: true }).click();
    await expect(page.getByRole('button', { name: '5s', exact: true })).toHaveClass(/is-active/);
    const fiveSecondHistory = await page.request.get(
      `${apiUrl}/v1/markets/BTC-USD/candles?interval=5s&limit=600`,
    );
    expect(fiveSecondHistory.status()).toBe(200);
    const fiveSecondBody = await fiveSecondHistory.json();
    expect(fiveSecondBody.data).toHaveLength(600);
    const olderFiveSecondHistory = await page.request.get(
      `${apiUrl}/v1/markets/BTC-USD/candles?interval=5s&limit=600&before=${encodeURIComponent(fiveSecondBody.pagination.nextBefore)}`,
    );
    expect(olderFiveSecondHistory.status()).toBe(200);
    expect((await olderFiveSecondHistory.json()).data).toHaveLength(600);
    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'BTC-USD', price: '100050.00' },
    });
    await page.getByRole('button', { name: '15s', exact: true }).click();
    await page.getByRole('button', { name: '15m', exact: true }).click();
    await page.getByRole('button', { name: 'More timeframes' }).click();
    await page.getByRole('button', { name: /1s Experimental/ }).click();
    await expect(page.getByRole('button', { name: 'More timeframes' })).toHaveClass(/is-active/);
    await selectMarket('ETH/USD');
    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'BTC-USD', price: '100075.00' },
    });
    await expect(page.locator('.market-selector-trigger')).toContainText('ETH/USD');
    await expect(page.locator('.market-chart')).toHaveAttribute('aria-label', /ETH\/USD/);
    await page.getByRole('button', { name: '1m', exact: true }).click();
    await expect(page.getByRole('button', { name: '1m', exact: true })).toHaveClass(/is-active/);

    await Promise.all([
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'ETH-USD', price: '4100.00' },
      }),
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'SOL-USD', price: '200.00' },
      }),
    ]);
    await selectMarket('SOL/USD');
    await page.getByRole('button', { name: '4h', exact: true }).click();
    await page.getByRole('button', { name: 'Line chart' }).click();
    await page.getByRole('button', { name: /Indicators/ }).click();
    await page.getByLabel('SMA period').fill('25');
    await page.getByText('RSI', { exact: true }).click();
    await expect(page.getByText(/VWAP and Volume use exchange-reported/)).toBeVisible();
    await page.getByRole('button', { name: 'Close indicators' }).click();

    await page.getByRole('button', { name: /SHORT S/ }).click();
    await page.getByRole('button', { name: 'Market', exact: true }).click();
    await page.getByLabel('Margin amount in USD').fill('500.00');
    await page.getByRole('button', { name: 'Place SHORT Order' }).click();
    await page.getByRole('button', { name: 'Confirm SHORT SOL' }).click();
    await expect(page.getByText('SHORT SOL FILLED')).toBeVisible();
    await page.getByRole('button', { name: 'Positions', exact: true }).click();
    await expect(page.locator('.terminal-table--positions')).toContainText('SHORT');
    await page
      .locator('.terminal-table--positions .terminal-table__row')
      .filter({ hasText: 'SOL/USD' })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.locator('.sell-ticket')).toContainText('BUY TO CLOSE');
    await expect(page.locator('.sell-ticket')).toContainText('never opens or reverses a long');
    await page
      .getByRole('group', { name: 'Position reduction' })
      .getByRole('button', { name: '25%' })
      .click();
    await page.getByRole('button', { name: 'Buy to Close 25% SHORT' }).click();
    await page.getByRole('button', { name: 'Confirm 25% Close' }).click();
    await expect(page.getByText('SHORT SOL FILLED')).toBeVisible();
    await page.getByRole('button', { name: 'Positions', exact: true }).click();
    await expect(
      page
        .locator('.terminal-table--positions .terminal-table__row')
        .filter({ hasText: 'SOL/USD' }),
    ).toContainText('SHORT');

    await page.reload();
    await expect(page.locator('.market-selector-trigger')).toContainText('SOL/USD');
    await expect(page.getByRole('button', { name: '4h', exact: true })).toHaveClass(/is-active/);
    await expect(page.getByRole('button', { name: 'Line chart' })).toHaveClass(/is-active/);
  });

  test('keeps multiple entries isolated during active-entry switching', async () => {
    await page.goto(`/tournaments/${E2E.slug}`);
    await page.getByRole('button', { name: 'Create entry' }).click();
    await expect(page.getByText('Entry #2 created')).toBeVisible();
    await expect(page.locator('.entry-confirmation')).toContainText('$10,025.00');
    await expect(page.locator('.entry-confirmation')).toContainText('Entry price locked at $40.00');
    await expect(page.locator('.entry-confirmation')).toContainText('Current prize pool $55.00');
    const href = await page.getByRole('link', { name: /Open terminal/ }).getAttribute('href');
    secondEntryId = href!.split('/').at(-1)!;
    await page.getByRole('link', { name: /Open terminal/ }).click();
    await expect(page.getByText('No open positions')).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Active tournament entry' })
      .selectOption(firstEntryId);
    await expect(page).toHaveURL(new RegExp(firstEntryId));
    await page.getByRole('button', { name: 'Positions', exact: true }).click();
    await expect(page.locator('.terminal-table--positions')).toContainText('ETH/USD');
    await expect(page.locator('.terminal-table--positions')).toContainText('SOL/USD');
    await page
      .getByRole('combobox', { name: 'Active tournament entry' })
      .selectOption(secondEntryId);
    await expect(page).toHaveURL(new RegExp(secondEntryId));
    await page.getByRole('button', { name: 'Positions', exact: true }).click();
    await expect(page.getByText('No open positions')).toBeVisible();
    await expect(page.locator('.terminal-account-strip')).toContainText('$10,025.00');
    await page
      .getByRole('combobox', { name: 'Active tournament entry' })
      .selectOption(firstEntryId);
    await expect(page.getByRole('combobox', { name: 'Active tournament entry' })).toHaveValue(
      firstEntryId,
    );
    await expect(page.locator('.tournament-metrics')).toContainText('TOTAL P&L');
    await expect(page.locator('.tournament-metrics')).toContainText('PROJECTED PRIZE');
    await expect(page.locator('.tournament-metrics')).toContainText('PODIUM GAP');
    await expect(page.locator('.tournament-metrics')).toContainText('CASH LINE');
    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'SOL-USD', price: '220.00' },
    });
    await expect(page.locator('.rank-feedback.is-changing')).toContainText('#2', {
      timeout: 10_000,
    });
    await expect(page.locator('.mini-leaderboard__row.is-current > strong')).toHaveText('#2');
    await page.request.post(`${apiUrl}/v1/dev/market/advance`, {
      data: { symbol: 'SOL-USD', price: '200.00' },
    });
    await expect(page.locator('.rank-feedback.is-changing')).toContainText('#1', {
      timeout: 10_000,
    });
    await expect(page.locator('.mini-leaderboard__row.is-current > strong')).toHaveText('#1');
  });

  test('keeps PostgreSQL account state across logout, login, and navigation', async () => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/login?returnTo=%2Fdashboard');
    await page.getByRole('button', { name: /E2E Trader/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Entry #1').first()).toBeVisible();
    await expect(page.getByText('Entry #2').first()).toBeVisible();
    await page.reload();
    await expect(page.getByText('Entry #1').first()).toBeVisible();
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await page.getByRole('button', { name: 'Positions', exact: true }).click();
    await expect(page.locator('.terminal-table--positions')).toContainText('ETH/USD');
    await expect(page.locator('.terminal-table--positions')).toContainText('SOL/USD');
  });

  test('enforces scheduled trading start and independent entry/trading close boundaries', async () => {
    const sql = postgres(databaseUrl);
    await sql`
      UPDATE tournaments SET trading_starts_at = now() + interval '30 minutes',
        entry_closes_at = now() + interval '1 hour', trading_closes_at = now() + interval '2 hours'
      WHERE id = ${E2E.tournamentId}
    `;
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await expect(page.locator('.professional-submit')).toBeDisabled();
    const early = await page.request.post(`${apiUrl}/v1/orders`, {
      headers: { 'Idempotency-Key': 'e2e-before-trading-start' },
      data: { entryId: firstEntryId, symbol: 'BTC-USD', side: 'BUY', notional: '1.00' },
    });
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('TRADING_NOT_STARTED');

    await sql`
      UPDATE tournaments SET trading_starts_at = now() - interval '1 hour',
        entry_closes_at = now() - interval '1 second', trading_closes_at = now() + interval '1 hour'
      WHERE id = ${E2E.tournamentId}
    `;
    await page.goto(`/tournaments/${E2E.slug}`);
    await expect(page.getByRole('button', { name: 'Entry unavailable' })).toBeDisabled();
    const closedEntry = await page.request.post(
      `${apiUrl}/v1/tournaments/${E2E.tournamentId}/entries`,
      { data: {} },
    );
    expect(closedEntry.status()).toBe(409);
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await expect(page.locator('.professional-submit')).toBeEnabled();
    await sql`
      UPDATE tournaments SET trading_starts_at = now() - interval '1 hour',
        entry_closes_at = now() + interval '1 day', trading_closes_at = now() + interval '2 days'
      WHERE id = ${E2E.tournamentId}
    `;
    await sql.end();
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
    await sql`UPDATE tournaments SET entry_closes_at = now() - interval '2 seconds', trading_closes_at = now() - interval '1 second' WHERE id = ${E2E.tournamentId}`;
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await expect(page.locator('.professional-submit')).toBeDisabled();
    const response = await page.request.post(`${apiUrl}/v1/orders`, {
      headers: { 'Idempotency-Key': 'e2e-closed-order' },
      data: { entryId: firstEntryId, symbol: 'BTC-USD', side: 'BUY', notional: '1.00' },
    });
    expect(response.status()).toBe(409);
    await sql.begin(async (transaction) => {
      await transaction`UPDATE tournaments SET status = 'TRADING_ACTIVE', entry_closes_at = now() + interval '1 day', trading_closes_at = now() + interval '2 days' WHERE id = ${E2E.tournamentId}`;
      await transaction`DELETE FROM tournament_settlement_marks WHERE tournament_id = ${E2E.tournamentId}`;
    });
    await sql.end();
  });

  test('recovers and resynchronizes after a network reconnect', async () => {
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await Promise.all([
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'ETH-USD', price: '4100.00' },
      }),
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'SOL-USD', price: '200.00' },
      }),
    ]);
    await page.reload();
    await expect(page.locator('.market-freshness')).toContainText('DEV DATA');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText(/Realtime connection degraded|reconnect/i).first()).toBeVisible();
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.market-freshness')).toContainText('DEV DATA', {
      timeout: 20_000,
    });
  });

  test('isolates rapid symbol switches from slow prior-market history', async () => {
    await page.route('**/v1/markets/ETH-USD/candles**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue().catch(() => undefined);
    });
    await selectMarket('ETH/USD');
    await selectMarket('SOL/USD');
    await selectMarket('BTC/USD');
    await expect(page.locator('.market-chart')).toHaveAttribute('aria-label', /BTC\/USD .* chart/);
    await expect(page.locator('.market-depth-panel')).toContainText('Market depth · Deterministic');
    await expect(page.locator('.market-depth-panel')).toContainText('SIMULATED');
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('preserves terminal hierarchy without page overflow across target viewports', async () => {
    const viewports = [
      { width: 1920, height: 1080, stacked: false },
      { width: 1440, height: 900, stacked: false },
      { width: 1366, height: 768, stacked: false },
      { width: 1280, height: 800, stacked: false },
      { width: 1024, height: 768, stacked: true },
      { width: 820, height: 1024, stacked: true },
      { width: 390, height: 844, stacked: true },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
      await expect(page.locator('.professional-terminal-grid')).toBeVisible();
      const layout = await page.evaluate(() => {
        const chart = document.querySelector('.chart-workspace')!.getBoundingClientRect();
        const ticket = document
          .querySelector('.professional-order-ticket')!
          .getBoundingClientRect();
        const submit = document.querySelector('.professional-submit')!.getBoundingClientRect();
        return {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          chart: { left: chart.left, top: chart.top, bottom: chart.bottom },
          ticket: { left: ticket.left, top: ticket.top },
          submit: { top: submit.top, bottom: submit.bottom },
          ticketBottom: ticket.bottom,
        };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
      if (viewport.stacked)
        expect(layout.ticket.top).toBeGreaterThanOrEqual(layout.chart.bottom - 1);
      else {
        expect(Math.abs(layout.ticket.top - layout.chart.top)).toBeLessThanOrEqual(1);
        expect(layout.ticket.left).toBeGreaterThan(layout.chart.left);
        expect(layout.submit.top).toBeGreaterThanOrEqual(layout.ticket.top);
        expect(layout.submit.bottom).toBeLessThanOrEqual(layout.ticketBottom + 1);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await Promise.all([
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'ETH-USD', price: '4100.00' },
      }),
      page.request.post(`${apiUrl}/v1/dev/market/advance`, {
        data: { symbol: 'SOL-USD', price: '200.00' },
      }),
    ]);
    const redis = createClient({ url: redisUrl });
    await redis.connect();
    const websocketRateKeys = await redis.keys('rate:ws-*');
    if (websocketRateKeys.length) await redis.del(websocketRateKeys);
    await redis.quit();
    await page.goto(`/tournaments/${E2E.slug}/trade/${firstEntryId}`);
    await expect(page.locator('.market-freshness')).toContainText('DEV DATA', {
      timeout: 20_000,
    });
    const terminalMask = [
      page.locator('.market-chart'),
      page.locator('.terminal-close-time'),
      page.locator('.market-freshness'),
      page.locator('.active-market-price span'),
      page.locator('.market-watchlist b'),
      page.locator('.scanner-signals b'),
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
