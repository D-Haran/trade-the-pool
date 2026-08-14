import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { buildApp } from './app.js';
import { sessionKey } from './auth.js';
import { RedisKeyValueStore, type KeyValueStore } from './infrastructure.js';
import { walletChallengeKey } from './wallet-auth.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = createDatabase(databaseUrl);
const store = new RedisKeyValueStore(redisUrl);
const market = new DeterministicMarketPriceSource(new Date());
const config = {
  NODE_ENV: 'test' as const,
  DEV_AUTH_ENABLED: true,
  API_DOCS_ENABLED: false,
  TRUST_PROXY: false,
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  SESSION_TTL_SECONDS: 3600,
  WALLET_AUTH_ENABLED: true,
  SOLANA_CLUSTER: 'devnet' as const,
  WALLET_AUTH_ORIGIN: 'http://localhost:3000',
  WALLET_AUTH_DOMAIN: 'localhost:3000',
  WALLET_CHALLENGE_TTL_SECONDS: 300,
};
const app = await buildApp({ db: connection.db, market, store, config });

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const createdUsers = new Set<string>();
let tournamentId = '';
let entryId = '';
let cookie = '';
let userId = '';
let websocketUrl = '';

function wallet() {
  const keys = nacl.sign.keyPair();
  return { keys, address: bs58.encode(keys.publicKey) };
}

function signedProof(
  challenge: { challengeId: string; message: string },
  signer: ReturnType<typeof wallet>,
  overrides: Partial<{ address: string; message: string; signature: string }> = {},
) {
  const message = Buffer.from(overrides.message ?? challenge.message, 'utf8');
  return {
    challengeId: challenge.challengeId,
    address: overrides.address ?? signer.address,
    signedMessage: message.toString('base64'),
    signature:
      overrides.signature ??
      Buffer.from(nacl.sign.detached(message, signer.keys.secretKey)).toString('base64'),
  };
}

function responseCookie(
  response: { headers: Record<string, string | string[] | number | undefined> },
  name: string,
) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const value = values.find((candidate) => candidate.startsWith(`${name}=`));
  if (!value) throw new Error(`${name} cookie was not issued`);
  return value.split(';')[0];
}

function cookieHeader(...cookies: Array<string | undefined>): string {
  return cookies.filter(Boolean).join('; ');
}

async function challenge(
  signer: ReturnType<typeof wallet>,
  purpose: 'LOGIN' | 'LINK' = 'LOGIN',
  sessionCookie?: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: purpose === 'LOGIN' ? '/v1/auth/wallet/challenge' : '/v1/me/wallets/challenge',
    headers: {
      origin: 'http://localhost:3000',
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
    payload: { address: signer.address },
  });
  expect(response.statusCode).toBe(200);
  return {
    ...(response.json().data as {
      challengeId: string;
      purpose: 'LOGIN' | 'LINK';
      network: 'devnet';
      input: Record<string, string>;
      message: string;
    }),
    flowCookie: responseCookie(response, 'ttp_wallet_flow'),
  };
}

async function walletLogin(signer: ReturnType<typeof wallet>, previousCookie?: string) {
  const issued = await challenge(signer, 'LOGIN', previousCookie);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/wallet/verify',
    headers: {
      origin: 'http://localhost:3000',
      cookie: cookieHeader(previousCookie, issued.flowCookie),
    },
    payload: signedProof(issued, signer),
  });
  expect(response.statusCode).toBe(200);
  createdUsers.add(response.json().data.user.id);
  return { response, cookie: responseCookie(response, 'ttp_session'), challenge: issued };
}

function nextMessage(socket: WebSocket) {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 3000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as unknown);
    });
  });
}

beforeAll(async () => {
  await store.connect();
  const staleKeys = await store.client.keys('wallet-challenge:*');
  const rateKeys = await store.client.keys('rate:wallet-*');
  if (staleKeys.length) await store.client.del(staleKeys);
  if (rateKeys.length) await store.client.del(rateKeys);
  const [tournament] = await connection.client`
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config)
    VALUES
      (${`wallet-auth-${suffix}`}, 'Wallet auth integration', 'Wallet auth fixture',
       'TRADING_ACTIVE', 10000.00, 0.00, now() - interval '2 hours',
       now() - interval '1 hour', now() + interval '1 hour', now() + interval '2 hours', 3,
       ${JSON.stringify({ directPrizes: [{ position: 1, basisPoints: 10000 }] })})
    RETURNING id
  `;
  tournamentId = tournament.id;
  await connection.client`
    INSERT INTO tournament_entry_fee_tiers
      (tournament_id, ordinal, min_prize_pool, max_prize_pool, entry_fee,
       prize_pool_contribution, platform_fee, future_reward_allocation)
    VALUES (${tournamentId}, 0, 0.00, NULL, 0.00, 0.00, 0.00, 0.00)
  `;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('API did not bind');
  websocketUrl = `ws://127.0.0.1:${address.port}/v1/realtime`;
});

describe.sequential('wallet authentication integration', () => {
  const primary = wallet();
  const additional = wallet();

  it('creates a user only after proof, issues a session, and authorizes private WebSockets', async () => {
    const issued = await challenge(primary);
    expect(issued).toMatchObject({
      purpose: 'LOGIN',
      network: 'devnet',
      input: {
        address: primary.address,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: 'solana:devnet',
        version: '1',
      },
    });
    expect(issued.message).toContain('does not authorize a transaction or transfer funds');
    expect(
      await connection.client`SELECT count(*)::int AS count FROM user_wallets WHERE address = ${primary.address}`,
    ).toEqual([{ count: 0 }]);

    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { origin: 'http://localhost:3000', cookie: issued.flowCookie },
      payload: signedProof(issued, primary),
    });
    expect(verified.statusCode).toBe(200);
    cookie = responseCookie(verified, 'ttp_session');
    userId = verified.json().data.user.id;
    createdUsers.add(userId);
    expect(
      await connection.client`SELECT user_id, is_primary FROM user_wallets WHERE address = ${primary.address}`,
    ).toEqual([{ user_id: userId, is_primary: true }]);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    const entry = await app.inject({
      method: 'POST',
      url: `/v1/tournaments/${tournamentId}/entries`,
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {},
    });
    expect(entry.statusCode).toBe(201);
    entryId = entry.json().data.id;
    const socket = new WebSocket(websocketUrl, {
      headers: { Cookie: cookie, Origin: 'http://localhost:3000' },
    });
    const ready = nextMessage(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    expect(await ready).toMatchObject({ type: 'connection.ready' });
    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ action: 'subscribe', topic: `entry:${entryId}` }));
    expect(await subscribed).toMatchObject({
      type: 'subscription.acknowledged',
      topic: `entry:${entryId}`,
    });
    socket.close();
  });

  it('rejects replay, message changes, wrong wallets, and malformed proofs', async () => {
    const replaySource = await challenge(additional);
    const valid = signedProof(replaySource, additional);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: replaySource.flowCookie },
      payload: valid,
    });
    expect(first.statusCode).toBe(200);
    createdUsers.add(first.json().data.user.id);
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: replaySource.flowCookie },
      payload: valid,
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('WALLET_CHALLENGE_INVALID');

    const modified = await challenge(primary);
    const modifiedResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: modified.flowCookie },
      payload: signedProof(modified, primary, { message: `${modified.message}\nmodified` }),
    });
    expect(modifiedResponse.statusCode).toBe(401);
    expect(modifiedResponse.json().error.code).toBe('WALLET_SIGNATURE_INVALID');

    const wrong = wallet();
    const wrongChallenge = await challenge(primary);
    const wrongResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: wrongChallenge.flowCookie },
      payload: signedProof(wrongChallenge, wrong, { address: primary.address }),
    });
    expect(wrongResponse.statusCode).toBe(401);

    const malformedChallenge = await challenge(primary);
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: malformedChallenge.flowCookie },
      payload: {
        challengeId: malformedChallenge.challengeId,
        address: primary.address,
        signature: '***',
        signedMessage: '***',
      },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects expired challenges and resolves concurrent first logins to one wallet owner', async () => {
    const expiringWallet = wallet();
    const expired = await challenge(expiringWallet);
    const key = walletChallengeKey(expired.challengeId);
    const state = JSON.parse((await store.get(key))!) as { input: { expirationTime: string } };
    state.input.expirationTime = new Date(0).toISOString();
    await store.set(key, JSON.stringify(state));
    const expiredResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/verify',
      headers: { cookie: expired.flowCookie },
      payload: signedProof(expired, expiringWallet),
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(expiredResponse.json().error.code).toBe('WALLET_CHALLENGE_EXPIRED');

    const concurrentWallet = wallet();
    const first = await challenge(concurrentWallet);
    const second = await challenge(concurrentWallet);
    const responses = await Promise.all(
      [first, second].map((issued) =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/wallet/verify',
          headers: { cookie: issued.flowCookie },
          payload: signedProof(issued, concurrentWallet),
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const resolvedIds = responses.map((response) => response.json().data.user.id);
    resolvedIds.forEach((id) => createdUsers.add(id));
    expect(new Set(resolvedIds).size).toBe(1);
    expect(
      await connection.client`SELECT count(*)::int AS count FROM user_wallets WHERE address = ${concurrentWallet.address}`,
    ).toEqual([{ count: 1 }]);
  });

  it('logs into an existing user and rotates the prior server session', async () => {
    const oldCookie = cookie;
    const oldSessionId = oldCookie.slice('ttp_session='.length);
    const result = await walletLogin(primary, oldCookie);
    cookie = result.cookie;
    expect(result.response.json().data.user.id).toBe(userId);
    expect(cookie).not.toBe(oldCookie);
    expect(await store.get(sessionKey(oldSessionId))).toBeNull();
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: oldCookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('links wallets to the authenticated user and rejects reassignment', async () => {
    const linkChallenge = await challenge(additional, 'LINK', cookie);
    const linked = await app.inject({
      method: 'POST',
      url: '/v1/me/wallets/verify',
      headers: {
        cookie: cookieHeader(cookie, linkChallenge.flowCookie),
        origin: 'http://localhost:3000',
      },
      payload: signedProof(linkChallenge, additional),
    });
    expect(linked.statusCode).toBe(409);
    expect(linked.json().error.code).toBe('WALLET_OWNED_BY_ANOTHER_USER');

    const fresh = wallet();
    const freshChallenge = await challenge(fresh, 'LINK', cookie);
    const freshLinked = await app.inject({
      method: 'POST',
      url: '/v1/me/wallets/verify',
      headers: {
        cookie: cookieHeader(cookie, freshChallenge.flowCookie),
        origin: 'http://localhost:3000',
      },
      payload: signedProof(freshChallenge, fresh),
    });
    expect(freshLinked.statusCode).toBe(201);
    expect(freshLinked.json().data).toMatchObject({
      address: fresh.address,
      isPrimary: false,
    });

    const list = await app.inject({ method: 'GET', url: '/v1/me/wallets', headers: { cookie } });
    expect(list.json().data).toHaveLength(2);
    expect(list.json().data.filter((item: { isPrimary: boolean }) => item.isPrimary)).toHaveLength(
      1,
    );
  });

  it('changes primary deterministically, unlinks safely, and protects the final method', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/me/wallets', headers: { cookie } });
    const rows = list.json().data as Array<{ id: string; address: string; isPrimary: boolean }>;
    const secondary = rows.find((row) => !row.isPrimary)!;
    const promoted = await app.inject({
      method: 'PUT',
      url: `/v1/me/wallets/${secondary.id}/primary`,
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {},
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().data.isPrimary).toBe(true);

    const formerPrimary = rows.find((row) => row.isPrimary)!;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/me/wallets/${formerPrimary.id}`,
      headers: { cookie, origin: 'http://localhost:3000' },
    });
    expect(removed.statusCode).toBe(204);
    const last = await app.inject({
      method: 'DELETE',
      url: `/v1/me/wallets/${secondary.id}`,
      headers: { cookie, origin: 'http://localhost:3000' },
    });
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('WALLET_LAST_AUTH_METHOD');
  });

  it('applies the dedicated repeated-invalid-signature limit', async () => {
    const rateKeys = await store.client.keys('rate:wallet-*');
    if (rateKeys.length) await store.client.del(rateKeys);
    const attacker = wallet();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const issued = await challenge(attacker);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/wallet/verify',
        headers: { cookie: issued.flowCookie },
        payload: signedProof(issued, attacker, {
          signature: Buffer.alloc(64, attempt + 1).toString('base64'),
        }),
      });
      expect(response.statusCode).toBe(attempt < 5 ? 401 : 429);
      expect(response.json().error.code).toBe(
        attempt < 5 ? 'WALLET_SIGNATURE_INVALID' : 'RATE_LIMITED',
      );
    }
  });

  it('fails safely on Redis outages and rate-limits challenge spam', async () => {
    const unavailableStore: KeyValueStore = {
      get: (...args) => store.get(...args),
      getDelete: async () => {
        throw new Error('Redis unavailable');
      },
      set: async () => {
        throw new Error('Redis unavailable');
      },
      delete: (...args) => store.delete(...args),
      ttl: (...args) => store.ttl(...args),
      increment: (...args) => store.increment(...args),
      ping: (...args) => store.ping(...args),
      close: async () => undefined,
    };
    const unavailableApp = await buildApp({
      db: connection.db,
      market,
      store: unavailableStore,
      config,
    });
    const signer = wallet();
    const unavailable = await unavailableApp.inject({
      method: 'POST',
      url: '/v1/auth/wallet/challenge',
      payload: { address: signer.address },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe('WALLET_AUTHENTICATION_UNAVAILABLE');
    await unavailableApp.close();

    const rateKeys = await store.client.keys('rate:wallet-challenge-*');
    if (rateKeys.length) await store.client.del(rateKeys);
    const rateWallet = wallet();
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/wallet/challenge',
        payload: { address: rateWallet.address },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/wallet/challenge',
      payload: { address: rateWallet.address },
    });
    expect(limited.statusCode).toBe(429);
  });
});

afterAll(async () => {
  if (tournamentId) {
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
    await connection.client`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id = ${tournamentId}`;
    await connection.client`DELETE FROM tournaments WHERE id = ${tournamentId}`;
  }
  if (createdUsers.size) {
    const ids = [...createdUsers];
    await connection.client`DELETE FROM user_wallets WHERE user_id = ANY(${ids}::uuid[])`;
    await connection.client`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
  }
  await app.close();
  await store.close();
  await connection.client.end();
});
