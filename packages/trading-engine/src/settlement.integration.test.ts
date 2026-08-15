import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import {
  DeterministicMarketPriceSource,
  SUPPORTED_SYMBOLS,
  type MarketPriceProvider,
} from '@trade-the-pool/market-data';
import {
  createTournamentEntry,
  getAccountSummary,
  settleTournament,
  submitTradingOrder,
} from './index.js';

const connection = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const { client, db } = connection;

async function fixture<T>(
  run: (input: {
    entryId: string;
    tournamentId: string;
    market: DeterministicMarketPriceSource;
    now: Date;
  }) => Promise<T>,
): Promise<T> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [user] = await client`
    INSERT INTO users (display_name) VALUES (${`Settlement trader ${suffix}`}) RETURNING id
  `;
  const [tournament] = await client`
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config)
    VALUES
      (${`settlement-${suffix}`}, 'Settlement', 'Settlement fixture',
       'TRADING_ACTIVE', 10000.00, 0.00, now() - interval '2 hours', now() - interval '1 hour',
       now() + interval '1 hour', now() + interval '2 hours', 1,
       ${JSON.stringify({ directPrizes: [{ position: 1, basisPoints: 10000 }] })})
    RETURNING id
  `;
  await client`
    INSERT INTO tournament_entry_fee_tiers
      (tournament_id, ordinal, min_prize_pool, max_prize_pool, entry_fee,
       prize_pool_contribution, platform_fee, future_reward_allocation)
    VALUES (${tournament.id}, 0, 0.00, NULL, 0.00, 0.00, 0.00, 0.00)
  `;
  const entry = await createTournamentEntry(db, tournament.id, user.id);
  const now = new Date();
  const market = new DeterministicMarketPriceSource(now);
  try {
    return await run({ entryId: entry.id, tournamentId: tournament.id, market, now });
  } finally {
    await client`DELETE FROM tournament_settlement_marks WHERE tournament_id = ${tournament.id}`;
    await client`DELETE FROM account_ledger_entries WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM fills WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM positions WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM orders WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM tournament_entries WHERE id = ${entry.id}`;
    await client`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id = ${tournament.id}`;
    await client`DELETE FROM tournaments WHERE id = ${tournament.id}`;
    await client`DELETE FROM users WHERE id = ${user.id}`;
  }
}

describe('tournament settlement', () => {
  it('locks one fresh mark set, expires open orders, freezes exact equity, and replays', async () => {
    await fixture(async ({ entryId, tournamentId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '1000.00',
          idempotencyKey: 'settlement-position',
        },
        { now },
      );
      const pending = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'SOL-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'LIMIT',
          requestedNotional: '250.00',
          limitPrice: '100.00',
          idempotencyKey: 'settlement-pending',
        },
        { now },
      );
      expect(pending.order.status).toBe('OPEN');

      const settledAt = new Date(now.getTime() + 5);
      await client`
        UPDATE tournaments
        SET entry_closes_at = ${settledAt.toISOString()},
            trading_closes_at = ${settledAt.toISOString()}
        WHERE id = ${tournamentId}
      `;
      market.advancePrice('BTC-USD', '101000.00', settledAt);
      market.advancePrice('ETH-USD', '4100.00', settledAt);
      market.advancePrice('SOL-USD', '205.00', settledAt);
      const expected = await getAccountSummary(db, market, entryId, { now: settledAt });

      const result = await settleTournament(db, market, tournamentId, { now: settledAt });
      expect(Object.keys(result.settlementMarks).sort()).toEqual([...SUPPORTED_SYMBOLS].sort());
      const [tournament] = await client`
        SELECT status FROM tournaments WHERE id = ${tournamentId}
      `;
      const [entry] = await client`
        SELECT current_equity, realized_pnl, unrealized_pnl
        FROM tournament_entries WHERE id = ${entryId}
      `;
      const [order] = await client`SELECT status FROM orders WHERE id = ${pending.order.id}`;
      const marks = await client`
        SELECT symbol, price, source FROM tournament_settlement_marks
        WHERE tournament_id = ${tournamentId} ORDER BY symbol
      `;
      expect(tournament.status).toBe('COMPLETED');
      expect(entry).toMatchObject({
        current_equity: expected.equity,
        realized_pnl: expected.realizedPnL,
        unrealized_pnl: expected.unrealizedPnL,
      });
      expect(order.status).toBe('EXPIRED');
      expect(marks).toHaveLength(SUPPORTED_SYMBOLS.length);
      expect(new Set(marks.map((mark) => mark.source))).toEqual(
        new Set(['deterministic-memory-v1']),
      );

      const unavailable: MarketPriceProvider = {
        getSnapshot() {
          throw new Error('upstream unavailable');
        },
      };
      const replay = await settleTournament(db, unavailable, tournamentId, {
        now: new Date(settledAt.getTime() + 60_000),
      });
      expect(replay.settlementMarks).toEqual(result.settlementMarks);
      expect(
        await client`
          SELECT count(*)::int AS count FROM tournament_settlement_marks
          WHERE tournament_id = ${tournamentId}
        `,
      ).toEqual([{ count: SUPPORTED_SYMBOLS.length }]);
    });
  });

  it('fails closed without mutating competition state when marks are stale', async () => {
    await fixture(async ({ tournamentId, market, now }) => {
      const staleAt = new Date(now.getTime() + 30_001);
      await client`
        UPDATE tournaments
        SET entry_closes_at = ${staleAt.toISOString()},
            trading_closes_at = ${staleAt.toISOString()}
        WHERE id = ${tournamentId}
      `;
      await expect(
        settleTournament(db, market, tournamentId, { now: staleAt }),
      ).rejects.toMatchObject({ code: 'STALE_MARKET_PRICE' });
      const [tournament] = await client`
        SELECT status FROM tournaments WHERE id = ${tournamentId}
      `;
      const [marks] = await client`
        SELECT count(*)::int AS count FROM tournament_settlement_marks
        WHERE tournament_id = ${tournamentId}
      `;
      expect(tournament.status).toBe('TRADING_CLOSED');
      expect(marks.count).toBe(0);
    });
  });
});

afterAll(() => client.end());
