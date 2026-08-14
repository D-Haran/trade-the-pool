import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { RedisKeyValueStore } from './infrastructure.js';
import { RealtimeHub, connectMarketRealtime } from './realtime.js';
import { AccountSnapshotService, LeaderboardService } from './services.js';

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
const disconnectMarket = connectMarketRealtime(market, hub, leaderboards);
const app = await buildApp({
  db: connection.db,
  market,
  store,
  hub,
  config: {
    NODE_ENV: 'test',
    DEV_AUTH_ENABLED: true,
    API_DOCS_ENABLED: true,
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    SESSION_TTL_SECONDS: 3600,
  },
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
  return (Array.isArray(header) ? header[0] : header)!.split(';')[0];
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
  const [user] = await connection.client`
    INSERT INTO users (display_name) VALUES (${`API Trader ${suffix}`}) RETURNING id
  `;
  const [other] = await connection.client`
    INSERT INTO users (display_name) VALUES (${`Other API Trader ${suffix}`}) RETURNING id
  `;
  const [tournament] = await connection.client`
    INSERT INTO tournaments
      (slug, name, description, status, simulated_pool, simulated_entry_contribution,
       opens_at, entry_closes_at, trading_closes_at, max_entries_per_user)
    VALUES
      (${`api-${suffix}`}, 'API integration', 'API fixture', 'OPEN', 10000.00, 25.00,
       now(), now() + interval '1 hour', now() + interval '2 hours', 3)
    RETURNING id
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
    expect(detail.json().data.allowedSymbols).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);

    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/me/entries' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('identifies sessions, rejects invalid/expired sessions, and invalidates logout', async () => {
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.id).toBe(userId);

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'ttp_session=invalid' },
    });
    expect(invalid.statusCode).toBe(401);

    await store.set(
      'session:expired-test',
      JSON.stringify({ userId, expiresAt: new Date(0).toISOString() }),
    );
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: 'ttp_session=expired-test' },
    });
    expect(expired.statusCode).toBe(401);

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
      startingBankroll: '10000.00',
      tournamentPool: '10025.00',
    });
    entryId = created.json().data.id;

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
    expect(first.json().data).toMatchObject({ status: 'FILLED', resultingCash: '8999.00' });

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

  it('maps insufficient cash, oversell, malformed payload, stale market, and deadline failures', async () => {
    const insufficient = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'too-much' },
      payload: { entryId, symbol: 'BTC-USD', side: 'BUY', notional: '10000.00' },
    });
    expect(insufficient.json().error.code).toBe('INSUFFICIENT_CASH');

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
      UPDATE tournaments SET trading_closes_at = now() - interval '1 second'
      WHERE id = ${tournamentId}
    `;
    const closed = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { cookie, 'idempotency-key': 'closed-market' },
      payload: { entryId, symbol: 'ETH-USD', side: 'BUY', notional: '1.00' },
    });
    expect(closed.json().error.code).toBe('TOURNAMENT_NOT_TRADABLE');
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

    socket.send(JSON.stringify({ action: 'subscribe', topic: 'market:SOL-USD' }));
    expect(await next()).toMatchObject({
      type: 'subscription.acknowledged',
      topic: 'market:SOL-USD',
    });
    market.advancePrice('SOL-USD', '205.00', new Date(Date.now() + 1));
    expect(await next()).toMatchObject({
      topic: 'market:SOL-USD',
      event: { type: 'market.price', price: '205.00000000' },
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
      UPDATE tournaments SET status = 'OPEN', trading_closes_at = now() + interval '1 hour'
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
});

afterAll(async () => {
  disconnectMarket();
  await connection.client`
    DELETE FROM account_ledger_entries WHERE entry_id IN
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
  await connection.client`DELETE FROM tournaments WHERE id = ${tournamentId}`;
  await connection.client`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`;
  await app.close();
  await store.close();
  await connection.client.end();
});
