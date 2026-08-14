import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import { parseQuantity } from '@trade-the-pool/shared';
import {
  createTournamentEntry,
  DomainError,
  executeMarketOrder,
  getAccountSummary,
  reconcileEntry,
} from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool';
const connection = createDatabase(databaseUrl);
const { client, db } = connection;

type Fixture = { tournamentId: string; userId: string; entryId: string };

async function createFixture(startingBankroll = '10000.00'): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [user] = await client`
    INSERT INTO users (display_name) VALUES (${`Trader ${suffix}`}) RETURNING id
  `;
  const [tournament] = await client`
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool, entry_contribution,
       entry_closes_at, trading_closes_at, max_entries_per_user)
    VALUES
      (${`trading-${suffix}`}, 'Trading integration', 'Trading fixture', 'OPEN',
       ${startingBankroll}, 0.00, 0.00, now() + interval '1 hour', now() + interval '2 hours', 1)
    RETURNING id
  `;
  const entry = await createTournamentEntry(db, tournament.id, user.id);
  return { tournamentId: tournament.id, userId: user.id, entryId: entry.id };
}

async function removeFixture(fixture: Fixture): Promise<void> {
  await client`DELETE FROM account_ledger_entries WHERE entry_id = ${fixture.entryId}`;
  await client`DELETE FROM fills WHERE entry_id = ${fixture.entryId}`;
  await client`DELETE FROM positions WHERE entry_id = ${fixture.entryId}`;
  await client`DELETE FROM orders WHERE entry_id = ${fixture.entryId}`;
  await client`DELETE FROM tournament_entries WHERE id = ${fixture.entryId}`;
  await client`DELETE FROM tournaments WHERE id = ${fixture.tournamentId}`;
  await client`DELETE FROM users WHERE id = ${fixture.userId}`;
}

async function withFixture<T>(
  callback: (fixture: Fixture, market: DeterministicMarketPriceSource, now: Date) => Promise<T>,
  startingBankroll = '10000.00',
): Promise<T> {
  const fixture = await createFixture(startingBankroll);
  const now = new Date();
  const market = new DeterministicMarketPriceSource(now);
  try {
    return await callback(fixture, market, now);
  } finally {
    await removeFixture(fixture);
  }
}

function code(error: unknown): string | undefined {
  return error instanceof DomainError ? error.code : undefined;
}

describe('atomic PostgreSQL market execution', () => {
  it('executes a profitable buy/full-close scenario with exact ledger and reconciliation', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      const buy = await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          side: 'BUY',
          requestedNotional: '5000.00',
          idempotencyKey: 'profitable-buy',
        },
        { now },
      );
      expect(buy.order.status).toBe('FILLED');
      expect(buy.fill.referencePrice).toBe('100000.00000000');
      expect(buy.fill.notional).toBe('5000.00');
      expect(buy.fill.feeAmount).toBe('5.00');
      expect(buy.fill.marketSource).toBe('deterministic-memory-v1');

      market.advancePrice('BTC-USD', '110000.00', new Date(now.getTime() + 1));
      const marked = await getAccountSummary(db, market, entryId, {
        now: new Date(now.getTime() + 1),
      });
      expect(marked.cash).toBe('4995.00');
      expect(marked.unrealizedPnL).toBe('497.20');
      expect(marked.equity).toBe('10492.20');

      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          side: 'SELL',
          percentageBps: 10_000,
          idempotencyKey: 'profitable-close',
        },
        { now: new Date(now.getTime() + 1) },
      );
      const closed = await getAccountSummary(db, market, entryId, {
        now: new Date(now.getTime() + 1),
      });
      expect(closed.positions[0].quantity).toBe('0.00000000');
      expect(closed.unrealizedPnL).toBe('0.00');
      expect(closed.realizedPnL).toBe('494.39');
      expect(closed.cash).toBe('10483.90');
      await expect(
        reconcileEntry(db, market, entryId, { now: new Date(now.getTime() + 1) }),
      ).resolves.toEqual(closed);

      const ledger = await client`
        SELECT type, amount, sum(amount) OVER ()::numeric(20,2)::text AS total
        FROM account_ledger_entries
        WHERE entry_id = ${entryId} ORDER BY created_at, type
      `;
      expect(ledger).toHaveLength(5);
      expect(ledger.filter((row) => row.type === 'TRADING_FEE')).toHaveLength(2);
      expect(ledger[0].total).toBe(closed.cash);
      const [entry] = await client`
        SELECT starting_bankroll FROM tournament_entries WHERE id = ${entryId}
      `;
      expect(entry.starting_bankroll).toBe('10000.00');
    });
  });

  it('handles multiple buys, a partial sell, and a losing close using average cost', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          side: 'BUY',
          requestedNotional: '1000.00',
          idempotencyKey: 'sol-buy-1',
        },
        { now },
      );
      market.advancePrice('SOL-USD', '220.00', new Date(now.getTime() + 1));
      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          side: 'BUY',
          requestedNotional: '1100.00',
          idempotencyKey: 'sol-buy-2',
        },
        { now: new Date(now.getTime() + 1) },
      );
      const before = await getAccountSummary(db, market, entryId, {
        now: new Date(now.getTime() + 1),
      });
      const average = before.positions[0].averageEntryPrice;
      const originalQuantity = parseQuantity(before.positions[0].quantity);

      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          side: 'SELL',
          percentageBps: 5_000,
          idempotencyKey: 'sol-partial',
        },
        { now: new Date(now.getTime() + 1) },
      );
      const partial = await getAccountSummary(db, market, entryId, {
        now: new Date(now.getTime() + 1),
      });
      expect(partial.positions[0].averageEntryPrice).toBe(average);
      expect(parseQuantity(partial.positions[0].quantity)).toBe(
        originalQuantity - (originalQuantity * 5_000n) / 10_000n,
      );

      market.advancePrice('SOL-USD', '150.00', new Date(now.getTime() + 2));
      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          side: 'SELL',
          percentageBps: 10_000,
          idempotencyKey: 'sol-losing-close',
        },
        { now: new Date(now.getTime() + 2) },
      );
      const closed = await getAccountSummary(db, market, entryId, {
        now: new Date(now.getTime() + 2),
      });
      expect(closed.positions[0].quantity).toBe('0.00000000');
      expect(closed.unrealizedPnL).toBe('0.00');
      expect(closed.realizedPnL.startsWith('-')).toBe(true);
    });
  });

  it('rejects insufficient cash, oversells, unsupported symbols, stale prices, and closed trading without mutation', async () => {
    await withFixture(async ({ entryId, tournamentId }, market, now) => {
      const invalidRequests = [
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'BTC-USD',
            side: 'BUY',
            requestedNotional: '10000.00',
            idempotencyKey: 'no-fee-cash',
          },
          { now },
        ),
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'DOGE-USD',
            side: 'BUY',
            requestedNotional: '1.00',
            idempotencyKey: 'unsupported',
          },
          { now },
        ),
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'BTC-USD',
            side: 'BUY',
            requestedNotional: '0.00',
            idempotencyKey: 'zero-notional',
          },
          { now },
        ),
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'BTC-USD',
            side: 'BUY',
            requestedNotional: '-1.00',
            idempotencyKey: 'negative-notional',
          },
          { now },
        ),
      ];
      const results = await Promise.allSettled(invalidRequests);
      expect(
        results.map((result) => (result.status === 'rejected' ? code(result.reason) : 'ok')).sort(),
      ).toEqual(['INSUFFICIENT_CASH', 'INVALID_ORDER', 'INVALID_ORDER', 'UNSUPPORTED_SYMBOL']);
      market.advancePrice('BTC-USD', '100000.00', new Date(now.getTime() + 1));
      await expect(
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'BTC-USD',
            side: 'BUY',
            requestedNotional: '1.00',
            idempotencyKey: 'stale',
          },
          { now: new Date(now.getTime() + 30_002) },
        ),
      ).rejects.toMatchObject({ code: 'STALE_MARKET_PRICE' });
      await client`UPDATE tournaments SET status = 'TRADING_CLOSED' WHERE id = ${tournamentId}`;
      await expect(
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'BTC-USD',
            side: 'BUY',
            requestedNotional: '1.00',
            idempotencyKey: 'closed',
          },
          { now: new Date(now.getTime() + 1) },
        ),
      ).rejects.toMatchObject({ code: 'TOURNAMENT_NOT_TRADABLE' });
      const [counts] = await client`
        SELECT
          (SELECT count(*)::int FROM orders WHERE entry_id = ${entryId}) AS orders,
          (SELECT count(*)::int FROM fills WHERE entry_id = ${entryId}) AS fills,
          (SELECT count(*)::int FROM positions WHERE entry_id = ${entryId}) AS positions,
          (SELECT count(*)::int FROM account_ledger_entries WHERE entry_id = ${entryId}) AS ledger
      `;
      expect(counts).toEqual({ orders: 0, fills: 0, positions: 0, ledger: 1 });
    });
  });
});

describe('PostgreSQL serialization and idempotency', () => {
  it('allows only one concurrent buy against limited cash', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      const results = await Promise.allSettled([
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'ETH-USD',
            side: 'BUY',
            requestedNotional: '75.00',
            idempotencyKey: 'limited-a',
          },
          { now },
        ),
        executeMarketOrder(
          db,
          market,
          {
            entryId,
            symbol: 'ETH-USD',
            side: 'BUY',
            requestedNotional: '75.00',
            idempotencyKey: 'limited-b',
          },
          { now },
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((result) => result.status === 'rejected')
          .map((result) => code(result.reason)),
      ).toEqual(['INSUFFICIENT_CASH']);
      await expect(reconcileEntry(db, market, entryId, { now })).resolves.toBeDefined();
    }, '100.00');
  });

  it('allows only one concurrent full-position sell', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      const buy = await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          side: 'BUY',
          requestedNotional: '1000.00',
          idempotencyKey: 'sell-race-buy',
        },
        { now },
      );
      const quantity = buy.fill.quantity;
      const results = await Promise.allSettled([
        executeMarketOrder(
          db,
          market,
          { entryId, symbol: 'SOL-USD', side: 'SELL', quantity, idempotencyKey: 'sell-race-a' },
          { now },
        ),
        executeMarketOrder(
          db,
          market,
          { entryId, symbol: 'SOL-USD', side: 'SELL', quantity, idempotencyKey: 'sell-race-b' },
          { now },
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((result) => result.status === 'rejected')
          .map((result) => code(result.reason)),
      ).toEqual(['INSUFFICIENT_POSITION']);
      const summary = await reconcileEntry(db, market, entryId, { now });
      expect(summary.positions[0].quantity).toBe('0.00000000');
    });
  });

  it('concurrently replays one logical order exactly once and rejects key reuse conflicts', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      const request = {
        entryId,
        symbol: 'BTC-USD',
        side: 'BUY' as const,
        requestedNotional: '1000.00',
        idempotencyKey: 'duplicate-buy',
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => executeMarketOrder(db, market, request, { now })),
      );
      expect(new Set(results.map((result) => result.order.id)).size).toBe(1);
      expect(new Set(results.map((result) => result.fill.id)).size).toBe(1);
      await expect(
        executeMarketOrder(db, market, { ...request, requestedNotional: '1001.00' }, { now }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_ORDER_CONFLICT' });
      const [counts] = await client`
        SELECT
          (SELECT count(*)::int FROM orders WHERE entry_id = ${entryId}) AS orders,
          (SELECT count(*)::int FROM fills WHERE entry_id = ${entryId}) AS fills,
          (SELECT count(*)::int FROM account_ledger_entries WHERE entry_id = ${entryId}) AS ledger
      `;
      expect(counts).toEqual({ orders: 1, fills: 1, ledger: 3 });
    });
  });

  it('rolls back every financial mutation on a forced mid-transaction failure', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      await client.unsafe(`
        CREATE OR REPLACE FUNCTION integration_fail_trading_fill()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced trading fill failure'; END;
        $$;
        CREATE TRIGGER integration_fail_trading_fill_trigger
        BEFORE INSERT ON fills FOR EACH ROW EXECUTE FUNCTION integration_fail_trading_fill();
      `);
      try {
        await expect(
          executeMarketOrder(
            db,
            market,
            {
              entryId,
              symbol: 'BTC-USD',
              side: 'BUY',
              requestedNotional: '1000.00',
              idempotencyKey: 'forced-rollback',
            },
            { now },
          ),
        ).rejects.toThrow('forced trading fill failure');
      } finally {
        await client.unsafe(
          'DROP TRIGGER IF EXISTS integration_fail_trading_fill_trigger ON fills',
        );
        await client.unsafe('DROP FUNCTION IF EXISTS integration_fail_trading_fill()');
      }
      const [state] = await client`
        SELECT e.cash, e.starting_bankroll,
          (SELECT count(*)::int FROM orders WHERE entry_id = ${entryId}) AS orders,
          (SELECT count(*)::int FROM fills WHERE entry_id = ${entryId}) AS fills,
          (SELECT count(*)::int FROM positions WHERE entry_id = ${entryId}) AS positions,
          (SELECT count(*)::int FROM account_ledger_entries WHERE entry_id = ${entryId}) AS ledger
        FROM tournament_entries e WHERE e.id = ${entryId}
      `;
      expect(state).toEqual({
        cash: '10000.00',
        starting_bankroll: '10000.00',
        orders: 0,
        fills: 0,
        positions: 0,
        ledger: 1,
      });
    });
  });

  it('reports rather than silently repairing reconciliation mismatches', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      await client`UPDATE tournament_entries SET cash = cash - 1 WHERE id = ${entryId}`;
      await expect(reconcileEntry(db, market, entryId, { now })).rejects.toMatchObject({
        code: 'FINANCIAL_INVARIANT_VIOLATION',
      });
      const [entry] = await client`SELECT cash FROM tournament_entries WHERE id = ${entryId}`;
      expect(entry.cash).toBe('9999.00');
    });
  });

  it('detects a position that no longer matches deterministic fill replay', async () => {
    await withFixture(async ({ entryId }, market, now) => {
      await executeMarketOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          side: 'BUY',
          requestedNotional: '1000.00',
          idempotencyKey: 'position-reconcile',
        },
        { now },
      );
      await client`
        UPDATE positions SET quantity = quantity + 0.00000001
        WHERE entry_id = ${entryId} AND symbol = 'ETH-USD'
      `;
      await expect(reconcileEntry(db, market, entryId, { now })).rejects.toMatchObject({
        code: 'FINANCIAL_INVARIANT_VIOLATION',
      });
    });
  });
});

afterAll(() => client.end());
