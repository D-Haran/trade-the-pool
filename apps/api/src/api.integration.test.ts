import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource, SUPPORTED_SYMBOLS } from '@trade-the-pool/market-data';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { sessionKey } from './auth.js';
import { RedisKeyValueStore, type KeyValueStore } from './infrastructure.js';
import { RealtimeHub, connectMarketRealtime } from './realtime.js';
import { AccountSnapshotService, LeaderboardService, TradingApiService } from './services.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool';
const connection = createDatabase(databaseUrl);
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const store = new RedisKeyValueStore(redisUrl);
const market = new DeterministicMarketPriceSource(new Date());
const hub = new RealtimeHub();
const snapshots = new AccountSnapshotService(connection.db, market);
const leaderboards = new LeaderboardService(connection.db, snapshots, store, hub);
const trading = new TradingApiService(connection.db, market, snapshots, leaderboards, hub);
const disconnectMarket = connectMarketRealtime(market, hub, leaderboards, (symbol) =>
  trading.processMarketTick(symbol),
);
const apiConfig = {
  NODE_ENV: 'test' as const,
  DEV_AUTH_ENABLED: true,
  API_DOCS_ENABLED: true,
  TRUST_PROXY: false,
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  SESSION_TTL_SECONDS: 3600,
  WALLET_AUTH_ENABLED: true,
  SOLANA_CLUSTER: 'devnet' as const,
  WALLET_AUTH_ORIGIN: 'http://localhost:3000',
  WALLET_AUTH_DOMAIN: 'localhost:3000',
  WALLET_CHALLENGE_TTL_SECONDS: 300,
};
const app = await buildApp({
  db: connection.db,
  market,
  store,
  hub,
  trading,
  config: apiConfig,
});

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let userId = '';
let otherUserId = '';
let tournamentId = '';
let entryId = '';
let cookie = '';
let otherCookie = '';
let websocketUrl = '';

async function login(id: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev/login',
    payload: { userId: id },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toContain('HttpOnly');
  expect(value).toContain('SameSite=Lax');
  expect(value).toContain('Path=/');
  expect(value).toContain('Max-Age=3600');
  expect(value).not.toContain('Secure');
  return value!.split(';')[0];
}

function websocketMessages(socket: WebSocket) {
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.on('message', (data) => {
    const value = JSON.parse(data.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  return async () => {
    if (messages.length) return messages.shift();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for WebSocket message')),
        3000,
      );
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
}

beforeAll(async () => {
  await store.connect();
  const staleRateKeys = await store.client.keys('rate:*');
  if (staleRateKeys.length) await store.client.del(staleRateKeys);
  const [user] = await connection.client`
    INSERT INTO users (display_name) VALUES (${`API Trader ${suffix}`}) RETURNING id
  `;
  const [other] = await connection.client`
    INSERT INTO users (display_name) VALUES (${`Other API Trader ${suffix}`}) RETURNING id
  `;
  const [tournament] = await connection.client`
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config)
    VALUES
      (${`api-${suffix}`}, 'API integration', 'API fixture', 'TRADING_ACTIVE', 10000.00, 500.00,
       now() - interval '2 hours', now() - interval '1 hour',
       now() + interval '1 hour', now() + interval '2 hours', 3,
       ${JSON.stringify({
         directPrizes: [
           { position: 1, basisPoints: 5000 },
           { position: 2, basisPoints: 3000 },
           { position: 3, basisPoints: 2000 },
         ],
       })})
    RETURNING id
  `;
  await connection.client`
    INSERT INTO tournament_entry_fee_tiers
      (tournament_id, ordinal, min_prize_pool, max_prize_pool, entry_fee,
       prize_pool_contribution, platform_fee, future_reward_allocation)
    VALUES (${tournament.id}, 0, 0.00, NULL, 25.00, 25.00, 0.00, 0.00)
  `;
  userId = user.id;
  otherUserId = other.id;
  tournamentId = tournament.id;
  cookie = await login(userId);
  otherCookie = await login(otherUserId);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('API did not bind a TCP port');
  websocketUrl = `ws://127.0.0.1:${address.port}/v1/realtime`;
});

describe('V1 HTTP API', () => {
  it('provides public tournament list/detail and rejects unauthenticated private reads', async () => {
    const specification = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(specification.statusCode).toBe(200);
    expect(Object.keys(specification.json().paths)).toContain('/orders');
    expect(specification.json().servers).toContainEqual({ url: '/v1' });

    const list = await app.inject({ method: 'GET', url: '/v1/tournaments?page=1&pageSize=10' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.some((row: { id: string }) => row.id === tournamentId)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/v1/tournaments/${tournamentId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.allowedSymbols).toEqual(SUPPORTED_SYMBOLS);
    expect(detail.json().data.maxEntriesPerUser).toBe(3);
    expect(detail.json().data).toMatchObject({
      baseBankroll: '10000.00',
      currentPrizePool: '500.00',
      newEntryBankroll: '10500.00',
      currentEntryPrice: '25.00',
      prizePoolContribution: '25.00',
      platformFee: '0.00',
    });
    expect(detail.json().data.payoutProjection).toMatchObject({
      firstPrize: '250.00',
      secondPrize: '150.00',
      thirdPrize: '100.00',
    });

    const bySlug = await app.inject({ method: 'GET', url: `/v1/tournaments/api-${suffix}` });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().data.id).toBe(tournamentId);

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/me/entries' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('provides authoritative market snapshots and deterministic candle history', async () => {
    const markets = await app.inject({ method: 'GET', url: '/v1/markets' });
    expect(markets.statusCode).toBe(200);
    expect(markets.json().data.map((item: { symbol: string }) => item.symbol)).toEqual(
      SUPPORTED_SYMBOLS,
    );
    const snapshot = await app.inject({ method: 'GET', url: '/v1/markets/BTC-USD' });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data).toMatchObject({
      symbol: 'BTC-USD',
      price: '100000.00000000',
      markPrice: '100000.00000000',
      source: 'deterministic-memory-v1',
      dataMode: 'fake',
      status: 'LIVE',
      exchangeStatus: 'LIVE',
      availability: 'ACTIVE',
      provenance: {
        currentPrice: 'deterministic-memory-v1',
        historicalCandles: 'deterministic-memory-v1',
        orderBook: 'deterministic-memory-v1',
        recentTrades: 'deterministic-memory-v1',
        authoritativeMark: 'deterministic-memory-v1',
      },
    });

    const candles = await app.inject({
      method: 'GET',
      url: '/v1/markets/BTC-USD/candles?interval=5m&limit=24',
    });
    expect(candles.statusCode).toBe(200);
    expect(candles.json().data).toHaveLength(24);
    expect(candles.json().data.at(-1)).toMatchObject({
      close: '100000.00000000',
      volume: expect.stringMatching(/^\d+\.\d{8}$/),
    });
    expect(candles.json().provenance).toBe('deterministic-memory-v1');

    const deepHistory = await app.inject({
      method: 'GET',
      url: '/v1/markets/BTC-USD/candles?interval=1m&limit=600',
    });
    expect(deepHistory.json().data).toHaveLength(600);
    const oldest = deepHistory.json().pagination.nextBefore;
    const olderHistory = await app.inject({
      method: 'GET',
      url: `/v1/markets/BTC-USD/candles?interval=1m&limit=600&before=${encodeURIComponent(oldest)}`,
    });
    expect(olderHistory.json().data).toHaveLength(600);
    expect(new Date(olderHistory.json().data.at(-1).timestamp).getTime()).toBeLessThan(
      new Date(deepHistory.json().data[0].timestamp).getTime(),
    );

    const seconds = await app.inject({
      method: 'GET',
      url: '/v1/markets/BTC-USD/candles?interval=1s&limit=120',
    });
    expect(seconds.statusCode).toBe(200);
    expect(seconds.json().data).toHaveLength(120);
    expect(seconds.json().data.at(-1)).toMatchObject({
      close: '100000.00000000',
      volume: expect.stringMatching(/^\d+\.\d{8}$/),
    });

    const book = await app.inject({
      method: 'GET',
      url: '/v1/markets/BTC-USD/book?depth=10',
    });
    expect(book.statusCode).toBe(200);
    expect(book.json().data).toMatchObject({
      symbol: 'BTC-USD',
      venue: 'Deterministic',
      status: 'LIVE',
    });
    expect(book.json().data.bids).toHaveLength(10);
    expect(book.json().data.asks).toHaveLength(10);
    expect(book.json().provenance).toBe('deterministic-memory-v1');

    const trades = await app.inject({ method: 'GET', url: '/v1/markets/BTC-USD/trades' });
    expect(trades.statusCode).toBe(200);
    expect(trades.json().data).toEqual([]);
    expect(trades.json().provenance).toBe('deterministic-memory-v1');

    const health = await app.inject({ method: 'GET', url: '/health/market-data' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      marketData: {
        mode: 'fake',
        components: { currentPrice: 'deterministic-memory-v1' },
      },
      realtime: { subscriberCount: 0, topicCount: 0 },
    });
  });

  it('identifies sessions, rejects invalid/expired sessions, and invalidates logout', async () => {
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.id).toBe(userId);
    const activeSessionId = cookie.slice('ttp_session='.length);
    expect(await store.ttl(sessionKey(activeSessionId))).toBeGreaterThan(3500);

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'ttp_session=invalid' },
    });
    expect(invalid.statusCode).toBe(401);

    const expiredId = 'a'.repeat(43);
    await store.set(
      sessionKey(expiredId),
      JSON.stringify({ userId, expiresAt: new Date(0).toISOString() }),
    );
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: `ttp_session=${expiredId}` },
    });
    expect(expired.statusCode).toBe(401);
    expect(await store.get(sessionKey(expiredId))).toBeNull();

    const rotatedFrom = await login(userId);
    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/login',
      headers: { cookie: rotatedFrom },
      payload: { userId },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedHeader = rotated.headers['set-cookie'];
    const rotatedCookie = (Array.isArray(rotatedHeader) ? rotatedHeader[0] : rotatedHeader)!.split(
      ';',
    )[0];
    expect(rotatedCookie).not.toBe(rotatedFrom);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: rotatedFrom } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: rotatedCookie } }))
        .statusCode,
    ).toBe(200);

    const lostCookie = await login(userId);
    await store.delete(sessionKey(lostCookie.slice('ttp_session='.length)));
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: lostCookie } }))
        .statusCode,
    ).toBe(401);

    const temporaryCookie = await login(userId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { cookie: temporaryCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: { cookie: temporaryCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('enforces exact browser origins for CSRF and credentialed CORS', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe('CSRF_VALIDATION_FAILED');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/orders',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('returns service unavailable, not unauthenticated, when Redis cannot be checked', async () => {
    const unavailableStore: KeyValueStore = {
      get: async () => {
        throw new Error('Redis temporarily unavailable');
      },
      getDelete: (...args) => store.getDelete(...args),
      set: (...args) => store.set(...args),
      delete: (...args) => store.delete(...args),
      ttl: (...args) => store.ttl(...args),
      increment: (...args) => store.increment(...args),
      ping: () => store.ping(),
      close: async () => undefined,
    };
    const unavailableApp = await buildApp({
      db: connection.db,
      market,
      store: unavailableStore,
      config: apiConfig,
    });
    const response = await unavailableApp.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('AUTHENTICATION_UNAVAILABLE');
    await unavailableApp.close();
  });

  it('creates an owned entry without trusting userId and enforces ownership', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tournaments/${tournamentId}/entries`,
      headers: { cookie },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      sequenceNumber: 1,
      tournamentEntryNumber: 1,
      entryFee: '25.00',
      prizePoolBeforeEntry: '500.00',
      baseBankrollSnapshot: '10000.00',
      startingBankroll: '10500.00',
      currentPrizePool: '525.00',
      newEntryBankroll: '10525.00',
    });
    entryId = created.json().data.id;

    await connection.client`
      UPDATE tournament_entries SET cash = 11500.00, current_equity = 11500.00 WHERE id = ${entryId}
    `;
    const scored = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}`,
      headers: { cookie },
    });
    expect(scored.json().data).toMatchObject({
      startingBankroll: '10500.00',
      equity: '11500.00',
      score: '1000.00',
    });
    await connection.client`
      UPDATE tournament_entries SET cash = 10500.00, current_equity = 10500.00 WHERE id = ${entryId}
    `;

    const impersonation = await app.inject({
      method: 'POST',
      url: `/v1/tournaments/${tournamentId}/entries`,
      headers: { cookie },
      payload: { userId: otherUserId },
    });
    expect(impersonation.statusCode).toBe(400);
    expect(impersonation.json().error.code).toBe('INVALID_REQUEST');

    const unauthorized = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}`,
      headers: { cookie: otherCookie },
    });
    expect(unauthorized.statusCode).toBe(403);
  });

  it('executes and idempotently replays orders, then exposes positions, history, and leaderboard', async () => {
    const request = {
      method: 'POST' as const,
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'api-buy-1' },
      payload: { entryId, symbol: 'SOL-USD', side: 'BUY', notional: '1000.00' },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.orderId).toBe(first.json().data.orderId);
    expect(first.json().data).toMatchObject({ status: 'FILLED', resultingCash: '9499.00' });

    const positions = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/positions`,
      headers: { cookie },
    });
    expect(positions.statusCode).toBe(200);
    expect(positions.json().data[0]).toMatchObject({
      symbol: 'SOL-USD',
      currentMark: '200.00000000',
    });

    const history = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/orders`,
      headers: { cookie },
    });
    expect(history.json().pagination.total).toBe(1);

    const beforeLoss = await app.inject({
      method: 'GET',
      url: `/v1/tournaments/${tournamentId}/leaderboard`,
      headers: { cookie },
    });
    expect(beforeLoss.statusCode).toBe(200);
    const original = beforeLoss.json().data;
    await store.delete(leaderboards.key(tournamentId));
    const rebuilt = await app.inject({
      method: 'GET',
      url: `/v1/tournaments/${tournamentId}/leaderboard`,
      headers: { cookie },
    });
    expect(rebuilt.json().data).toEqual(original);
  });

  it('supports professional short, protection, conditional cancellation, fills, and performance APIs', async () => {
    const opened = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'api-short-open' },
      payload: {
        entryId,
        symbol: 'ETH-USD',
        intent: 'OPEN',
        positionSide: 'SHORT',
        sizing: { type: 'MARGIN', amount: '250.00' },
        leverage: 2,
        execution: { type: 'MARKET' },
        takeProfitPrice: '3900.00',
        stopLossPrice: '4100.00',
      },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().data).toMatchObject({
      status: 'FILLED',
      side: 'SELL',
      positionSide: 'SHORT',
      intent: 'OPEN',
      leverage: 2,
      requestedNotional: '500.00',
    });

    const positions = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/positions`,
      headers: { cookie },
    });
    expect(positions.json().data).toContainEqual(
      expect.objectContaining({
        symbol: 'ETH-USD',
        side: 'SHORT',
        takeProfitPrice: '3900.00000000',
        stopLossPrice: '4100.00000000',
      }),
    );

    const protectedPosition = await app.inject({
      method: 'PUT',
      url: `/v1/entries/${entryId}/positions/ETH-USD/protection`,
      headers: { cookie, 'idempotency-key': 'api-short-protection' },
      payload: { takeProfitPrice: '3850.00', stopLossPrice: '4150.00' },
    });
    expect(protectedPosition.statusCode).toBe(200);
    expect(protectedPosition.json().data).toEqual([
      expect.objectContaining({ type: 'TAKE_PROFIT', status: 'OPEN' }),
      expect.objectContaining({ type: 'STOP_LOSS', status: 'OPEN' }),
    ]);

    const pending = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'api-btc-limit' },
      payload: {
        entryId,
        symbol: 'BTC-USD',
        intent: 'OPEN',
        positionSide: 'LONG',
        sizing: { type: 'POSITION_SIZE', amount: '500.00' },
        leverage: 1,
        execution: { type: 'LIMIT', limitPrice: '90000.00' },
      },
    });
    expect(pending.json().data.status).toBe('OPEN');
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/entries/${entryId}/orders/${pending.json().data.orderId}`,
      headers: { cookie },
    });
    expect(cancelled.json().data.status).toBe('CANCELLED');

    const partialClose = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'api-short-partial-close' },
      payload: {
        entryId,
        symbol: 'ETH-USD',
        intent: 'CLOSE',
        positionSide: 'SHORT',
        amount: { type: 'PERCENTAGE', percentageBps: 5000 },
        execution: { type: 'MARKET' },
      },
    });
    expect(partialClose.json().data).toMatchObject({ status: 'FILLED', intent: 'CLOSE' });

    const fills = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/fills`,
      headers: { cookie },
    });
    expect(fills.statusCode).toBe(200);
    expect(fills.json().data).toContainEqual(
      expect.objectContaining({ symbol: 'ETH-USD', positionSide: 'SHORT', intent: 'CLOSE' }),
    );
    const performance = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/performance`,
      headers: { cookie },
    });
    expect(performance.statusCode).toBe(200);
    expect(performance.json().data).toMatchObject({ numberOfTrades: 1, maxDrawdown: null });
  });

  it('maps insufficient cash, oversell, malformed payload, stale market, and deadline failures', async () => {
    const insufficient = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'too-much' },
      payload: { entryId, symbol: 'BTC-USD', side: 'BUY', notional: '10000.00' },
    });
    expect(insufficient.json().error.code).toBe('INSUFFICIENT_MARGIN');

    const oversell = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'oversell' },
      payload: {
        entryId,
        symbol: 'SOL-USD',
        side: 'SELL',
        amount: { type: 'QUANTITY', quantity: '9999.00000000' },
      },
    });
    expect(oversell.json().error.code).toBe('INSUFFICIENT_POSITION');

    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'malformed' },
      payload: { entryId, symbol: 'SOL-USD', side: 'BUY', notional: '1e3', price: '1.00' },
    });
    expect(malformed.json().error.code).toBe('INVALID_REQUEST');

    market.advancePrice('BTC-USD', '100000.00', new Date(Date.now() + 10_000));
    const future = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'future-market' },
      payload: { entryId, symbol: 'BTC-USD', side: 'BUY', notional: '1.00' },
    });
    expect(future.json().error.code).toBe('STALE_MARKET_PRICE');

    await connection.client`
      UPDATE tournaments SET entry_closes_at = now() - interval '2 seconds',
        trading_closes_at = now() - interval '1 second'
      WHERE id = ${tournamentId}
    `;
    const closed = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'closed-market' },
      payload: { entryId, symbol: 'ETH-USD', side: 'BUY', notional: '1.00' },
    });
    expect(closed.json().error.code).toBe('TOURNAMENT_NOT_TRADABLE');
    await connection.client`
      UPDATE tournaments SET status = 'TRADING_ACTIVE', trading_starts_at = now() - interval '1 hour',
        entry_closes_at = now() + interval '1 hour', trading_closes_at = now() + interval '2 hours'
      WHERE id = ${tournamentId}
    `;
  });

  it('keeps durable account state across logout, login, refresh, and API restart', async () => {
    const firstSession = await login(userId);
    const before = await app.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/orders?pageSize=100`,
      headers: { cookie: firstSession },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().pagination.total).toBeGreaterThan(0);

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/logout',
          headers: { cookie: firstSession },
        })
      ).statusCode,
    ).toBe(204);
    const secondSession = await login(userId);
    const entriesAfterLogin = await app.inject({
      method: 'GET',
      url: '/v1/me/entries?pageSize=100',
      headers: { cookie: secondSession },
    });
    expect(entriesAfterLogin.json().data).toContainEqual(expect.objectContaining({ id: entryId }));

    const restartedApp = await buildApp({
      db: connection.db,
      market,
      store,
      config: apiConfig,
    });
    const afterRestart = await restartedApp.inject({
      method: 'GET',
      url: `/v1/entries/${entryId}/orders?pageSize=100`,
      headers: { cookie: secondSession },
    });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json().data).toEqual(before.json().data);
    await restartedApp.close();
  });
});

describe('V1 WebSocket API', () => {
  it('authorizes topics, rejects malformed/private subscriptions, and broadcasts market updates', async () => {
    const socket = new WebSocket(websocketUrl, { headers: { Cookie: cookie } });
    const next = websocketMessages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    expect(await next()).toMatchObject({ type: 'connection.ready' });

    socket.send('{bad json');
    expect(await next()).toMatchObject({ error: { code: 'INVALID_SUBSCRIPTION' } });

    socket.send(JSON.stringify({ action: 'subscribe', topic: `entry:${entryId}` }));
    expect(await next()).toMatchObject({
      type: 'subscription.acknowledged',
      topic: `entry:${entryId}`,
    });

    socket.send(JSON.stringify({ action: 'subscribe', topic: `tournament:${tournamentId}` }));
    expect(await next()).toMatchObject({
      type: 'subscription.acknowledged',
      topic: `tournament:${tournamentId}`,
    });

    const secondEntry = await app.inject({
      method: 'POST',
      url: `/v1/tournaments/${tournamentId}/entries`,
      headers: { cookie },
      payload: {},
    });
    expect(secondEntry.statusCode).toBe(201);
    expect(secondEntry.json().data).toMatchObject({
      startingBankroll: '10525.00',
      currentPrizePool: '550.00',
      newEntryBankroll: '10550.00',
    });
    expect(await next()).toMatchObject({
      topic: `tournament:${tournamentId}`,
      event: { type: 'leaderboard.updated', tournamentId },
    });
    expect(await next()).toMatchObject({
      topic: `tournament:${tournamentId}`,
      event: {
        type: 'tournament.prize_pool_updated',
        currentPrizePool: '550.00',
        newEntryBankroll: '10550.00',
        totalEntries: 2,
      },
    });

    socket.send(JSON.stringify({ action: 'subscribe', topic: 'market:SOL-USD' }));
    expect(await next()).toMatchObject({
      type: 'subscription.acknowledged',
      topic: 'market:SOL-USD',
    });
    socket.send(JSON.stringify({ action: 'subscribe', topic: 'market:SOL-USD:candles:5s' }));
    expect(await next()).toMatchObject({
      type: 'subscription.acknowledged',
      topic: 'market:SOL-USD:candles:5s',
    });
    market.advancePrice('SOL-USD', '205.00', new Date(Date.now() + 1));
    expect(await next()).toMatchObject({
      topic: 'market:SOL-USD',
      event: {
        type: 'market.price',
        price: '205.00000000',
        markPrice: '205.00000000',
        status: 'LIVE',
        exchangeStatus: 'LIVE',
      },
    });
    expect(await next()).toMatchObject({
      topic: 'market:SOL-USD',
      event: { type: 'market.trades', symbol: 'SOL-USD' },
    });
    expect(await next()).toMatchObject({
      topic: 'market:SOL-USD:candles:5s',
      event: { type: 'market.candle', symbol: 'SOL-USD', interval: '5s' },
    });
    expect(await next()).toMatchObject({
      topic: 'market:SOL-USD',
      event: { type: 'market.book', symbol: 'SOL-USD', venue: 'Deterministic' },
    });
    expect(await next()).toMatchObject({
      topic: `tournament:${tournamentId}`,
      event: { type: 'leaderboard.updated', tournamentId },
    });
    expect(await next()).toMatchObject({
      topic: `entry:${entryId}`,
      event: { type: 'entry.account_updated', entryId },
    });

    await connection.client`
      UPDATE tournaments SET status = 'TRADING_ACTIVE', trading_starts_at = now() - interval '1 hour',
        entry_closes_at = now() + interval '30 minutes', trading_closes_at = now() + interval '1 hour'
      WHERE id = ${tournamentId}
    `;
    const order = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'websocket-sell' },
      payload: {
        entryId,
        symbol: 'SOL-USD',
        side: 'SELL',
        amount: { type: 'PERCENTAGE', percentageBps: 2500 },
      },
    });
    expect(order.statusCode).toBe(201);
    expect(await next()).toMatchObject({
      topic: `tournament:${tournamentId}`,
      event: { type: 'leaderboard.updated', tournamentId },
    });
    expect(await next()).toMatchObject({
      topic: `entry:${entryId}`,
      event: { type: 'entry.account_updated', entryId },
    });
    socket.close();

    const unauthorized = new WebSocket(websocketUrl, { headers: { Cookie: otherCookie } });
    const nextUnauthorized = websocketMessages(unauthorized);
    await new Promise<void>((resolve, reject) => {
      unauthorized.once('open', resolve);
      unauthorized.once('error', reject);
    });
    await nextUnauthorized();
    unauthorized.send(JSON.stringify({ action: 'subscribe', topic: `entry:${entryId}` }));
    expect(await nextUnauthorized()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
    unauthorized.close();

    const subscriptionRateKeys = await store.client.keys('rate:ws-subscription:*');
    if (subscriptionRateKeys.length) await store.client.del(subscriptionRateKeys);
    const limited = new WebSocket(websocketUrl, {
      headers: { 'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
    });
    const nextLimited = websocketMessages(limited);
    await new Promise<void>((resolve, reject) => {
      limited.once('open', resolve);
      limited.once('error', reject);
    });
    await nextLimited();
    for (let index = 0; index < 60; index += 1) {
      limited.send(JSON.stringify({ action: 'subscribe', topic: 'market:ETH-USD' }));
      expect(await nextLimited()).toMatchObject({ type: 'subscription.acknowledged' });
    }
    limited.send(JSON.stringify({ action: 'subscribe', topic: 'market:ETH-USD' }));
    expect(await nextLimited()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    limited.close();
  });

  it('revokes private sockets on logout and revalidates before private subscriptions', async () => {
    const logoutCookie = await login(userId);
    const socket = new WebSocket(websocketUrl, { headers: { Cookie: logoutCookie } });
    const next = websocketMessages(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await next();
    socket.send(JSON.stringify({ action: 'subscribe', topic: `entry:${entryId}` }));
    expect(await next()).toMatchObject({ type: 'subscription.acknowledged' });
    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: logoutCookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(await next()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });

    const lostCookie = await login(userId);
    const lostSocket = new WebSocket(websocketUrl, { headers: { Cookie: lostCookie } });
    const nextLost = websocketMessages(lostSocket);
    await new Promise<void>((resolve, reject) => {
      lostSocket.once('open', resolve);
      lostSocket.once('error', reject);
    });
    await nextLost();
    await store.delete(sessionKey(lostCookie.slice('ttp_session='.length)));
    lostSocket.send(JSON.stringify({ action: 'subscribe', topic: `entry:${entryId}` }));
    expect(await nextLost()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    lostSocket.close();
  });
});

afterAll(async () => {
  disconnectMarket();
  await connection.client`
    DELETE FROM account_ledger_entries WHERE entry_id IN
      (SELECT id FROM tournament_entries WHERE tournament_id = ${tournamentId})
  `;
  await connection.client`
    DELETE FROM fill_audits WHERE entry_id IN
      (SELECT id FROM tournament_entries WHERE tournament_id = ${tournamentId})
  `;
  await connection.client`
    DELETE FROM fills WHERE entry_id IN
      (SELECT id FROM tournament_entries WHERE tournament_id = ${tournamentId})
  `;
  await connection.client`
    DELETE FROM positions WHERE entry_id IN
      (SELECT id FROM tournament_entries WHERE tournament_id = ${tournamentId})
  `;
  await connection.client`
    DELETE FROM orders WHERE entry_id IN
      (SELECT id FROM tournament_entries WHERE tournament_id = ${tournamentId})
  `;
  await connection.client`DELETE FROM tournament_entries WHERE tournament_id = ${tournamentId}`;
  await connection.client`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id = ${tournamentId}`;
  await connection.client`DELETE FROM tournaments WHERE id = ${tournamentId}`;
  await connection.client`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`;
  await app.close();
  await store.close();
  await connection.client.end();
});
