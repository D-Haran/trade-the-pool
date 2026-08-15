import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import {
  parsePrice,
  parseQuantity,
  moneyFromMinorUnits,
  priceQuantityToMoney,
  signedMoneyToString,
} from '@trade-the-pool/shared';
import {
  createTournamentEntry,
  getAccountSummary,
  processConditionalOrders,
  processLiquidations,
  setPositionProtection,
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
    INSERT INTO users (display_name) VALUES (${`Professional trader ${suffix}`}) RETURNING id
  `;
  const [tournament] = await client`
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config)
    VALUES
      (${`professional-${suffix}`}, 'Professional trading', 'Professional order fixture',
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
    await client`DELETE FROM account_ledger_entries WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM fill_audits WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM fills WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM positions WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM orders WHERE entry_id = ${entry.id}`;
    await client`DELETE FROM tournament_entries WHERE id = ${entry.id}`;
    await client`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id = ${tournament.id}`;
    await client`DELETE FROM tournaments WHERE id = ${tournament.id}`;
    await client`DELETE FROM users WHERE id = ${user.id}`;
  }
}

describe('professional trading orders', () => {
  it('closes a modestly profitable 5x ETH short in stages without multiplying P&L or collapsing equity', async () => {
    await fixture(async ({ entryId, market, now }) => {
      const opened = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedMargin: '2000.00',
          leverage: 5,
          idempotencyKey: 'catastrophic-regression-open',
        },
        { now },
      );
      expect(opened.order).toMatchObject({ side: 'SELL', leverage: 5 });
      const profitableAt = new Date(now.getTime() + 1);
      market.advancePrice('ETH-USD', '3988.00', profitableAt);
      const profitable = await getAccountSummary(db, market, entryId, { now: profitableAt });
      expect(Number(profitable.unrealizedPnL)).toBeGreaterThan(0);

      const first = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 2_500,
          idempotencyKey: 'catastrophic-regression-quarter',
        },
        { now: profitableAt },
      );
      const replay = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 2_500,
          idempotencyKey: 'catastrophic-regression-quarter',
        },
        { now: profitableAt },
      );
      expect(replay).toMatchObject({ replayed: true, fill: { id: first.fill!.id } });
      const expectedFirstRealized =
        priceQuantityToMoney(
          parsePrice(opened.fill!.fillPrice),
          parseQuantity(first.fill!.quantity),
        ) -
        priceQuantityToMoney(
          parsePrice(first.fill!.fillPrice),
          parseQuantity(first.fill!.quantity),
        );
      expect(first.fill!.realizedPnL).toBe(
        signedMoneyToString(moneyFromMinorUnits(expectedFirstRealized)),
      );

      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 5_000,
          idempotencyKey: 'catastrophic-regression-half-remaining',
        },
        { now: profitableAt },
      );
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 10_000,
          idempotencyKey: 'catastrophic-regression-remainder',
        },
        { now: profitableAt },
      );
      const closed = await getAccountSummary(db, market, entryId, { now: profitableAt });
      expect(closed.positions[0]).toMatchObject({
        side: 'SHORT',
        leverage: 5,
        quantity: '0.00000000',
        marginUsed: '0.00',
      });
      expect(Number(closed.equity)).toBeGreaterThan(9_900);
      const auditRows = await client`
        SELECT trigger_type, position_side_before, position_side_after,
               equity_before, equity_after, margin_before, margin_after
        FROM fill_audits audit
        INNER JOIN fills fill ON fill.id = audit.fill_id
        WHERE audit.entry_id = ${entryId}
        ORDER BY fill.execution_sequence
      `;
      expect(auditRows).toHaveLength(4);
      expect(auditRows.at(-1)).toMatchObject({
        trigger_type: 'MANUAL_CLOSE',
        position_side_before: 'SHORT',
        position_side_after: 'NONE',
        margin_after: '0.00',
      });
    });
  });

  it('pauses liquidation and conditional exits when an ETH mark is degraded', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedMargin: '2000.00',
          leverage: 5,
          stopLossPrice: '4100.00',
          idempotencyKey: 'degraded-mark-short',
        },
        { now },
      );
      const malformedAt = new Date(now.getTime() + 1);
      const degraded = {
        getSnapshot() {
          return {
            symbol: 'ETH-USD' as const,
            price: parsePrice('188000'),
            marketTimestamp: malformedAt,
            receivedAt: malformedAt,
            source: 'malformed-fixture',
            status: 'DEGRADED' as const,
            executionEligible: false,
          };
        },
      };
      await expect(
        processLiquidations(db, degraded, 'ETH-USD', { now: malformedAt }),
      ).rejects.toMatchObject({ code: 'STALE_MARKET_PRICE' });
      await expect(
        processConditionalOrders(db, degraded, 'ETH-USD', { now: malformedAt }),
      ).rejects.toMatchObject({ code: 'STALE_MARKET_PRICE' });
      const [position] = await client`
        SELECT side, quantity FROM positions WHERE entry_id = ${entryId} AND symbol = 'ETH-USD'
      `;
      expect(position.side).toBe('SHORT');
      expect(Number(position.quantity)).toBeGreaterThan(0);
      const [closeCount] = await client`
        SELECT count(*)::int AS count FROM fills WHERE entry_id = ${entryId} AND intent = 'CLOSE'
      `;
      expect(closeCount.count).toBe(0);
    });
  });

  it('opens, marks, partially closes, and fully closes a 1x short with exact accounting', async () => {
    await fixture(async ({ entryId, market, now }) => {
      const opened = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '1000.00',
          idempotencyKey: 'short-open',
        },
        { now },
      );
      expect(opened.order).toMatchObject({ side: 'SELL', status: 'FILLED' });
      expect(opened.fill?.realizedPnL).toBe('0.00');
      const afterOpen = await getAccountSummary(db, market, entryId, { now });
      expect(afterOpen.positions[0].side).toBe('SHORT');
      expect(afterOpen.cash).toBe('10999.00');
      expect(Number(afterOpen.availableBuyingPower)).toBeGreaterThan(44_000);

      const movedAt = new Date(now.getTime() + 1);
      market.advancePrice('ETH-USD', '3800.00', movedAt);
      const marked = await getAccountSummary(db, market, entryId, { now: movedAt });
      expect(marked.unrealizedPnL.startsWith('-')).toBe(false);
      expect(BigInt(marked.unrealizedPnL.replace('.', ''))).toBeGreaterThan(0n);

      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 5_000,
          idempotencyKey: 'short-half',
        },
        { now: movedAt },
      );
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'CLOSE',
          orderType: 'MARKET',
          percentageBps: 10_000,
          idempotencyKey: 'short-close',
        },
        { now: movedAt },
      );
      const closed = await getAccountSummary(db, market, entryId, { now: movedAt });
      expect(closed.positions[0]).toMatchObject({ side: 'SHORT', quantity: '0.00000000' });
      expect(BigInt(closed.realizedPnL.replace('.', ''))).toBeGreaterThan(0n);
      expect(BigInt(closed.cash.replace('.', ''))).toBeGreaterThan(1_000_000n);
    });
  });

  it('fills crossed limits from authoritative ticks and allows cancellation before a trigger', async () => {
    await fixture(async ({ entryId, market, now }) => {
      const pending = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'LIMIT',
          requestedNotional: '500.00',
          limitPrice: '3900.00',
          takeProfitPrice: '4100.00',
          stopLossPrice: '3800.00',
          idempotencyKey: 'long-limit',
        },
        { now },
      );
      expect(pending.order.status).toBe('OPEN');
      const replay = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'LIMIT',
          requestedNotional: '500.00',
          limitPrice: '3900.00',
          takeProfitPrice: '4100.00',
          stopLossPrice: '3800.00',
          idempotencyKey: 'long-limit',
        },
        { now },
      );
      expect(replay.replayed).toBe(true);
      await expect(
        submitTradingOrder(
          db,
          market,
          {
            entryId,
            symbol: 'ETH-USD',
            positionSide: 'LONG',
            intent: 'OPEN',
            orderType: 'LIMIT',
            requestedNotional: '500.00',
            limitPrice: '3900.00',
            takeProfitPrice: '4200.00',
            stopLossPrice: '3800.00',
            idempotencyKey: 'long-limit',
          },
          { now },
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_ORDER_CONFLICT' });
      market.advancePrice('ETH-USD', '3850.00', new Date(now.getTime() + 1));
      const fills = await processConditionalOrders(db, market, 'ETH-USD', {
        now: new Date(now.getTime() + 1),
      });
      expect(fills).toHaveLength(1);
      expect(fills[0].order.status).toBe('FILLED');
      expect(
        (await getAccountSummary(db, market, entryId, { now: new Date(now.getTime() + 1) }))
          .positions[0].side,
      ).toBe('LONG');
      const protections = await client`
        SELECT order_type, trigger_price, status FROM orders
        WHERE parent_order_id = ${pending.order.id}
        ORDER BY order_type
      `;
      expect(protections).toEqual([
        { order_type: 'TAKE_PROFIT', trigger_price: '4100.00000000', status: 'OPEN' },
        { order_type: 'STOP_LOSS', trigger_price: '3800.00000000', status: 'OPEN' },
      ]);
    });
  });

  it('executes one attached exit and cancels its sibling without closing twice', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '1000.00',
          takeProfitPrice: '4100.00',
          stopLossPrice: '3900.00',
          idempotencyKey: 'protected-long',
        },
        { now },
      );
      const before = await client`
        SELECT status, order_type FROM orders
        WHERE entry_id = ${entryId} AND intent = 'CLOSE'
        ORDER BY order_type
      `;
      expect(before).toEqual([
        { status: 'OPEN', order_type: 'TAKE_PROFIT' },
        { status: 'OPEN', order_type: 'STOP_LOSS' },
      ]);

      const movedAt = new Date(now.getTime() + 1);
      market.advancePrice('ETH-USD', '4200.00', movedAt);
      const triggered = await processConditionalOrders(db, market, 'ETH-USD', { now: movedAt });
      expect(triggered).toHaveLength(1);
      const summary = await getAccountSummary(db, market, entryId, { now: movedAt });
      expect(summary.positions[0].quantity).toBe('0.00000000');
      const after = await client`
        SELECT status, count(*)::int AS count FROM orders
        WHERE entry_id = ${entryId} AND intent = 'CLOSE'
        GROUP BY status ORDER BY status
      `;
      expect(new Map(after.map((row) => [row.status, row.count]))).toEqual(
        new Map([
          ['CANCELLED', 1],
          ['FILLED', 1],
        ]),
      );
    });
  });

  it('executes a repeated conditional tick only once across concurrent processors', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '1000.00',
          takeProfitPrice: '4100.00',
          idempotencyKey: 'duplicate-trigger-position',
        },
        { now },
      );
      const movedAt = new Date(now.getTime() + 1);
      market.advancePrice('ETH-USD', '4200.00', movedAt);
      const passes = await Promise.all([
        processConditionalOrders(db, market, 'ETH-USD', { now: movedAt }),
        processConditionalOrders(db, market, 'ETH-USD', { now: movedAt }),
      ]);
      expect(passes.flat()).toHaveLength(1);
      const [closeFills] = await client`
        SELECT count(*)::int AS count FROM fills WHERE entry_id = ${entryId} AND intent = 'CLOSE'
      `;
      expect(closeFills.count).toBe(1);
    });
  });

  it('expires pending orders at tournament close even when their trigger is not crossed', async () => {
    await fixture(async ({ entryId, tournamentId, market, now }) => {
      const pending = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'LIMIT',
          requestedNotional: '500.00',
          limitPrice: '90000.00',
          idempotencyKey: 'expire-at-close',
        },
        { now },
      );
      expect(pending.order.status).toBe('OPEN');
      await client`
        UPDATE tournaments
        SET entry_closes_at = ${now.toISOString()},
            trading_closes_at = ${new Date(now.getTime() + 1).toISOString()}
        WHERE id = ${tournamentId}
      `;
      const closedAt = new Date(now.getTime() + 2);
      market.advancePrice('BTC-USD', '100000.00', closedAt);
      expect(await processConditionalOrders(db, market, 'BTC-USD', { now: closedAt })).toEqual([]);
      const [expired] = await client`
        SELECT status, cancellation_reason FROM orders WHERE id = ${pending.order.id}
      `;
      expect(expired).toEqual({
        status: 'EXPIRED',
        cancellation_reason: 'Tournament trading closed',
      });
    });
  });

  it('replays stop-loss-only protection updates and preserves unrelated close orders', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '1000.00',
          idempotencyKey: 'protection-position',
        },
        { now },
      );
      const manualClose = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'CLOSE',
          orderType: 'LIMIT',
          percentageBps: 2_500,
          limitPrice: '4500.00',
          idempotencyKey: 'manual-quarter-close',
        },
        { now },
      );
      const first = await setPositionProtection(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          takeProfitPrice: null,
          stopLossPrice: '3900.00',
          idempotencyKey: 'stop-only-protection',
        },
        { now },
      );
      const replay = await setPositionProtection(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          takeProfitPrice: null,
          stopLossPrice: '3900.00',
          idempotencyKey: 'stop-only-protection',
        },
        { now },
      );
      expect(first).toHaveLength(1);
      expect(replay.map((order) => order.id)).toEqual(first.map((order) => order.id));
      await expect(
        setPositionProtection(
          db,
          market,
          {
            entryId,
            symbol: 'ETH-USD',
            takeProfitPrice: null,
            stopLossPrice: '3800.00',
            idempotencyKey: 'stop-only-protection',
          },
          { now },
        ),
      ).rejects.toMatchObject({ code: 'DUPLICATE_ORDER_CONFLICT' });
      const [preserved] = await client`
        SELECT status FROM orders WHERE id = ${manualClose.order.id}
      `;
      expect(preserved.status).toBe('OPEN');
    });
  });

  it('keeps stale positions readable while rejecting new execution', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '500.00',
          idempotencyKey: 'stale-readable-position',
        },
        { now },
      );
      const staleNow = new Date(now.getTime() + 30_001);
      const readable = await getAccountSummary(db, market, entryId, { now: staleNow });
      expect(readable.positions[0]).toMatchObject({
        symbol: 'ETH-USD',
        currentMark: '4000.00000000',
      });
      await expect(
        submitTradingOrder(
          db,
          market,
          {
            entryId,
            symbol: 'SOL-USD',
            positionSide: 'LONG',
            intent: 'OPEN',
            orderType: 'MARKET',
            requestedNotional: '100.00',
            idempotencyKey: 'stale-execution-blocked',
          },
          { now: staleNow },
        ),
      ).rejects.toMatchObject({ code: 'STALE_MARKET_PRICE' });
    });
  });

  it('enforces asset leverage caps and reserves margin across simultaneous markets', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '25000.00',
          leverage: 5,
          idempotencyKey: 'btc-five-x',
        },
        { now },
      );
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '12000.00',
          leverage: 3,
          idempotencyKey: 'eth-three-x',
        },
        { now },
      );
      const summary = await getAccountSummary(db, market, entryId, { now });
      expect(
        summary.positions.filter((position) => position.quantity !== '0.00000000'),
      ).toHaveLength(2);
      expect(summary.positions.map((position) => [position.symbol, position.leverage])).toEqual([
        ['BTC-USD', 5],
        ['ETH-USD', 3],
      ]);
      expect(Number(summary.marginUsed)).toBeGreaterThan(8_900);
      await expect(
        submitTradingOrder(
          db,
          market,
          {
            entryId,
            symbol: 'SOL-USD',
            positionSide: 'LONG',
            intent: 'OPEN',
            orderType: 'MARKET',
            requestedNotional: '5000.00',
            leverage: 4,
            idempotencyKey: 'over-margin',
          },
          { now },
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_MARGIN' });
      await expect(
        submitTradingOrder(
          db,
          market,
          {
            entryId,
            symbol: 'SUI-USD',
            positionSide: 'LONG',
            intent: 'OPEN',
            orderType: 'MARKET',
            requestedNotional: '100.00',
            leverage: 3,
            idempotencyKey: 'above-sui-cap',
          },
          { now },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ORDER' });
    });
  });

  it('reserves margin for pending open orders before any fill occurs', async () => {
    await fixture(async ({ entryId, market, now }) => {
      const pending = await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'BTC-USD',
          positionSide: 'LONG',
          intent: 'OPEN',
          orderType: 'LIMIT',
          requestedNotional: '40000.00',
          leverage: 5,
          limitPrice: '40000.00000000',
          idempotencyKey: 'reserved-btc-margin',
        },
        { now },
      );
      expect(pending.order).toMatchObject({ status: 'OPEN', leverage: 5 });

      await expect(
        submitTradingOrder(
          db,
          market,
          {
            entryId,
            symbol: 'ETH-USD',
            positionSide: 'LONG',
            intent: 'OPEN',
            orderType: 'LIMIT',
            requestedNotional: '4000.00',
            leverage: 2,
            limitPrice: '3000.00000000',
            idempotencyKey: 'reserved-eth-margin-overflow',
          },
          { now },
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_MARGIN' });
    });
  });

  it('liquidates a leveraged position deterministically and records the event', async () => {
    await fixture(async ({ entryId, market, now }) => {
      await submitTradingOrder(
        db,
        market,
        {
          entryId,
          symbol: 'ETH-USD',
          positionSide: 'SHORT',
          intent: 'OPEN',
          orderType: 'MARKET',
          requestedNotional: '10000.00',
          leverage: 5,
          idempotencyKey: 'liquidated-short',
        },
        { now },
      );
      const opened = await getAccountSummary(db, market, entryId, { now });
      expect(opened.positions[0].liquidationPrice).not.toBeNull();
      const movedAt = new Date(now.getTime() + 1);
      market.advancePrice('ETH-USD', '5000.00', movedAt);
      const liquidations = await processLiquidations(db, market, 'ETH-USD', { now: movedAt });
      expect(liquidations).toHaveLength(1);
      expect(liquidations[0].order).toMatchObject({
        orderType: 'LIQUIDATION',
        status: 'FILLED',
        leverage: 5,
      });
      const closed = await getAccountSummary(db, market, entryId, { now: movedAt });
      expect(closed.positions[0]).toMatchObject({ quantity: '0.00000000', marginUsed: '0.00' });
      const [history] = await client`
        SELECT order_type, leverage, status FROM orders
        WHERE entry_id = ${entryId} AND order_type = 'LIQUIDATION'
      `;
      expect(history).toEqual({ order_type: 'LIQUIDATION', leverage: 5, status: 'FILLED' });
    });
  });
});

afterAll(() => client.end());
