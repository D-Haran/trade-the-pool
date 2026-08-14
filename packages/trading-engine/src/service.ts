import { and, asc, count, eq } from 'drizzle-orm';
import {
  accountLedgerEntries,
  fills,
  orders,
  positions,
  tournamentEntries,
  tournaments,
  type Database,
} from '@trade-the-pool/database';
import {
  SUPPORTED_SYMBOLS,
  type MarketPriceProvider,
  type MarketSymbol,
} from '@trade-the-pool/market-data';
import {
  moneyFromMinorUnits,
  decimalToString,
  moneyToString,
  parseMoney,
  parsePrice,
  parseQuantity,
  parseSignedMoney,
  priceQuantityToMoney,
  priceToString,
  quantityForMoney,
  quantityToString,
  signedMoneyToString,
  type Money,
  type Price,
  type Quantity,
} from '@trade-the-pool/shared';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from './config.js';
import {
  accountEquity,
  assertFreshSnapshot,
  assertTradable,
  buyPosition,
  calculateFee,
  calculateFillQuote,
  sellPosition,
  unrealizedPnL,
  type ExactPosition,
} from './domain.js';
import { DomainError } from './errors.js';

export type BuyMarketOrder = {
  entryId: string;
  symbol: string;
  side: 'BUY';
  requestedNotional: string;
  idempotencyKey: string;
};

export type SellMarketOrder = {
  entryId: string;
  symbol: string;
  side: 'SELL';
  quantity?: string;
  percentageBps?: number;
  idempotencyKey: string;
};

export type MarketOrderRequest = BuyMarketOrder | SellMarketOrder;
export type MarketOrderResult = {
  order: {
    id: string;
    entryId: string;
    symbol: MarketSymbol;
    side: 'BUY' | 'SELL';
    status: 'FILLED';
    idempotencyKey: string;
  };
  fill: {
    id: string;
    orderId: string;
    referencePrice: string;
    fillPrice: string;
    quantity: string;
    notional: string;
    spreadAmount: string;
    slippageAmount: string;
    feeAmount: string;
    marketSource: string;
    marketTimestamp: Date;
    serverTimestamp: Date;
  };
};

export type AccountSummary = {
  entryId: string;
  cash: string;
  realizedPnL: string;
  unrealizedPnL: string;
  equity: string;
  positions: Array<{
    symbol: MarketSymbol;
    quantity: string;
    averageEntryPrice: string;
    realizedPnL: string;
    unrealizedPnL: string;
  }>;
};

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function symbolFrom(value: string, config: ExecutionConfig): MarketSymbol {
  if (
    !(SUPPORTED_SYMBOLS as readonly string[]).includes(value) ||
    !(config.allowedSymbols as readonly string[]).includes(value)
  )
    throw new DomainError('UNSUPPORTED_SYMBOL', `Unsupported symbol: ${value}`);
  return value as MarketSymbol;
}

function validateIdempotencyKey(key: string): void {
  if (key.length === 0 || key.length > 128 || key.trim() !== key)
    throw new DomainError(
      'INVALID_ORDER',
      'Idempotency key must be 1-128 non-whitespace-padded characters',
    );
}

async function authoritativeSnapshot(
  provider: MarketPriceProvider,
  symbol: MarketSymbol,
  now: Date,
  config: ExecutionConfig,
) {
  const snapshot = await provider.getSnapshot(symbol);
  if (
    snapshot.symbol !== symbol ||
    snapshot.price <= 0n ||
    snapshot.source.length === 0 ||
    snapshot.source.length > 64
  )
    throw new DomainError(
      'FINANCIAL_INVARIANT_VIOLATION',
      'Market provider returned an invalid symbol, price, or source identifier',
    );
  assertFreshSnapshot(snapshot.marketTimestamp, now, config.stalePriceThresholdMs);
  return snapshot;
}

function invalidOrder(error: unknown): never {
  if (error instanceof DomainError) throw error;
  throw new DomainError('INVALID_ORDER', error instanceof Error ? error.message : 'Invalid order');
}

function exactPosition(row: typeof positions.$inferSelect): ExactPosition {
  const quantity = parseQuantity(row.quantity);
  return {
    symbol: row.symbol,
    quantity,
    averageEntryPrice: (quantity === 0n ? 0n : parsePrice(row.averageEntryPrice)) as Price,
    realizedPnL: parseSignedMoney(row.realizedPnL),
  };
}

function resultFromRows(
  order: typeof orders.$inferSelect,
  fill: typeof fills.$inferSelect,
): MarketOrderResult {
  if (order.status !== 'FILLED')
    throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Idempotent order is not filled');
  return {
    order: {
      id: order.id,
      entryId: order.entryId,
      symbol: order.symbol,
      side: order.side,
      status: order.status,
      idempotencyKey: order.idempotencyKey,
    },
    fill: {
      id: fill.id,
      orderId: fill.orderId,
      referencePrice: fill.referencePrice,
      fillPrice: fill.fillPrice,
      quantity: fill.quantity,
      notional: fill.notional,
      spreadAmount: fill.spreadAmount,
      slippageAmount: fill.slippageAmount,
      feeAmount: fill.feeAmount,
      marketSource: fill.marketSource,
      marketTimestamp: fill.marketTimestamp,
      serverTimestamp: fill.serverTimestamp,
    },
  };
}

function sameLogicalRequest(
  order: typeof orders.$inferSelect,
  request: MarketOrderRequest,
): boolean {
  if (order.symbol !== request.symbol || order.side !== request.side) return false;
  try {
    if (request.side === 'BUY')
      return order.requestedNotional === moneyToString(parseMoney(request.requestedNotional));
    const requestedQuantity = request.quantity
      ? quantityToString(parseQuantity(request.quantity))
      : null;
    return (
      order.requestedQuantity === requestedQuantity &&
      order.requestedPercentageBps === (request.percentageBps ?? null)
    );
  } catch {
    return false;
  }
}

async function existingResult(
  tx: Transaction,
  request: MarketOrderRequest,
): Promise<MarketOrderResult | null> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(eq(orders.entryId, request.entryId), eq(orders.idempotencyKey, request.idempotencyKey)),
    );
  if (!order) return null;
  if (!sameLogicalRequest(order, request))
    throw new DomainError(
      'DUPLICATE_ORDER_CONFLICT',
      'Idempotency key was already used for a different logical order',
    );
  const [fill] = await tx.select().from(fills).where(eq(fills.orderId, order.id));
  if (!fill) throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Filled order has no fill');
  return resultFromRows(order, fill);
}

async function calculateAndPersistAccountState(
  tx: Transaction,
  entryId: string,
  cash: Money,
  provider: MarketPriceProvider,
  config: ExecutionConfig,
  now: Date,
): Promise<{ realized: Money; unrealized: Money; equity: Money }> {
  const rows = await tx.select().from(positions).where(eq(positions.entryId, entryId));
  const exact = rows.map(exactPosition);
  const marks = new Map<MarketSymbol, Price>();
  let realized = moneyFromMinorUnits(0n);
  let unrealized = moneyFromMinorUnits(0n);
  for (const position of exact) {
    realized = moneyFromMinorUnits(realized + position.realizedPnL);
    if (position.quantity === 0n) continue;
    const snapshot = await authoritativeSnapshot(provider, position.symbol, now, config);
    marks.set(position.symbol, snapshot.price);
    unrealized = moneyFromMinorUnits(unrealized + unrealizedPnL(position, snapshot.price));
  }
  const equity = accountEquity(cash, exact, marks);
  await tx
    .update(tournamentEntries)
    .set({
      cash: moneyToString(cash),
      realizedPnL: signedMoneyToString(realized),
      unrealizedPnL: signedMoneyToString(unrealized),
      currentEquity: signedMoneyToString(equity),
      updatedAt: now,
    })
    .where(eq(tournamentEntries.id, entryId));
  return { realized, unrealized, equity };
}

export async function executeMarketOrder(
  db: Database,
  provider: MarketPriceProvider,
  request: MarketOrderRequest,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<MarketOrderResult> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  validateIdempotencyKey(request.idempotencyKey);
  const symbol = symbolFrom(request.symbol, config);

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, request.entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');

    const replay = await existingResult(tx, request);
    if (replay) return replay;

    const [tournament] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, entry.tournamentId));
    if (!tournament)
      throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Entry tournament does not exist');
    assertTradable(tournament.status, tournament.tradingClosesAt, now);

    const snapshot = await authoritativeSnapshot(provider, symbol, now, config);
    const [positionRow] = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.entryId, request.entryId), eq(positions.symbol, symbol)));
    const currentPosition = positionRow ? exactPosition(positionRow) : null;
    const cash = parseMoney(entry.cash);

    let quantity: Quantity;
    let referenceNotional: Money;
    let requestedNotional: string | null = null;
    let requestedQuantity: string | null = null;
    let requestedPercentageBps: number | null = null;
    try {
      if (request.side === 'BUY') {
        referenceNotional = parseMoney(request.requestedNotional);
        if (referenceNotional <= 0n || referenceNotional > config.maximumOrderNotional)
          throw new DomainError('INVALID_ORDER', 'Buy notional is outside the configured limits');
        requestedNotional = moneyToString(referenceNotional);
        const quote = calculateFillQuote(snapshot.price, 'BUY', referenceNotional, symbol, config);
        quantity = quantityForMoney(referenceNotional, quote.fillPrice);
      } else {
        const hasQuantity = request.quantity !== undefined;
        const hasPercentage = request.percentageBps !== undefined;
        if (hasQuantity === hasPercentage)
          throw new DomainError(
            'INVALID_ORDER',
            'Sell requires exactly one quantity or percentage',
          );
        if (!currentPosition)
          throw new DomainError('INSUFFICIENT_POSITION', 'No position exists for this symbol');
        if (hasQuantity) {
          quantity = parseQuantity(request.quantity!);
          requestedQuantity = quantityToString(quantity);
        } else {
          const bps = request.percentageBps!;
          if (!Number.isInteger(bps) || bps <= 0 || bps > 10_000)
            throw new DomainError('INVALID_ORDER', 'Sell percentage must be 1-10000 basis points');
          requestedPercentageBps = bps;
          quantity = ((currentPosition.quantity * BigInt(bps)) / 10_000n) as Quantity;
        }
        if (quantity <= 0n || quantity > currentPosition.quantity)
          throw new DomainError(
            'INSUFFICIENT_POSITION',
            'Sell quantity exceeds the owned position',
          );
        referenceNotional = priceQuantityToMoney(snapshot.price, quantity);
      }
    } catch (error) {
      invalidOrder(error);
    }

    const quote = calculateFillQuote(
      snapshot.price,
      request.side,
      referenceNotional,
      symbol,
      config,
    );
    if (request.side === 'BUY') quantity = quantityForMoney(referenceNotional, quote.fillPrice);
    const notional = priceQuantityToMoney(quote.fillPrice, quantity);
    if (quantity <= 0n || notional <= 0n)
      throw new DomainError('INVALID_ORDER', 'Order is too small to produce an exact fill');
    const fee = calculateFee(notional, config);

    let nextCash: Money;
    let nextPosition: ExactPosition;
    if (request.side === 'BUY') {
      const totalDebit = notional + fee;
      if (totalDebit > cash)
        throw new DomainError(
          'INSUFFICIENT_CASH',
          'Available cash does not cover notional and fee',
        );
      nextCash = moneyFromMinorUnits(cash - totalDebit);
      nextPosition = buyPosition(currentPosition, symbol, quantity, quote.fillPrice);
    } else {
      const sold = sellPosition(currentPosition, quantity, quote.fillPrice);
      nextPosition = sold.position;
      nextCash = moneyFromMinorUnits(cash + notional - fee);
    }
    if (nextCash < 0n || nextPosition.quantity < 0n)
      throw new DomainError(
        'FINANCIAL_INVARIANT_VIOLATION',
        'Order would violate financial invariants',
      );

    const [order] = await tx
      .insert(orders)
      .values({
        entryId: request.entryId,
        symbol,
        side: request.side,
        orderType: 'MARKET',
        requestedNotional,
        requestedQuantity,
        requestedPercentageBps,
        status: 'PENDING',
        idempotencyKey: request.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx
      .insert(positions)
      .values({
        entryId: request.entryId,
        symbol,
        quantity: quantityToString(nextPosition.quantity),
        averageEntryPrice:
          nextPosition.quantity === 0n
            ? '0.00000000'
            : priceToString(nextPosition.averageEntryPrice),
        realizedPnL: signedMoneyToString(nextPosition.realizedPnL),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [positions.entryId, positions.symbol],
        set: {
          quantity: quantityToString(nextPosition.quantity),
          averageEntryPrice:
            nextPosition.quantity === 0n
              ? '0.00000000'
              : priceToString(nextPosition.averageEntryPrice),
          realizedPnL: signedMoneyToString(nextPosition.realizedPnL),
          updatedAt: now,
        },
      });

    const [fill] = await tx
      .insert(fills)
      .values({
        orderId: order.id,
        entryId: request.entryId,
        executionSequence:
          (
            await tx
              .select({ value: count() })
              .from(fills)
              .where(eq(fills.entryId, request.entryId))
          )[0].value + 1,
        symbol,
        side: request.side,
        referencePrice: priceToString(quote.referencePrice),
        fillPrice: priceToString(quote.fillPrice),
        quantity: quantityToString(quantity),
        notional: moneyToString(notional),
        spreadAmount: decimalToString(quote.spreadAmount),
        slippageAmount: decimalToString(quote.slippageAmount),
        feeAmount: moneyToString(fee),
        marketSource: snapshot.source,
        marketTimestamp: snapshot.marketTimestamp,
        serverTimestamp: now,
        createdAt: now,
      })
      .returning();

    const ledgerValues =
      request.side === 'BUY'
        ? [
            {
              entryId: request.entryId,
              type: 'TRADE_CASH_DEBIT' as const,
              amount: signedMoneyToString(moneyFromMinorUnits(-notional)),
              referenceType: 'FILL',
              referenceId: fill.id,
              metadata: { orderId: order.id, symbol, side: request.side },
              createdAt: now,
            },
            {
              entryId: request.entryId,
              type: 'TRADING_FEE' as const,
              amount: signedMoneyToString(moneyFromMinorUnits(-fee)),
              referenceType: 'FILL',
              referenceId: fill.id,
              metadata: { orderId: order.id, symbol, side: request.side },
              createdAt: now,
            },
          ]
        : [
            {
              entryId: request.entryId,
              type: 'TRADE_CASH_CREDIT' as const,
              amount: moneyToString(notional),
              referenceType: 'FILL',
              referenceId: fill.id,
              metadata: { orderId: order.id, symbol, side: request.side },
              createdAt: now,
            },
            {
              entryId: request.entryId,
              type: 'TRADING_FEE' as const,
              amount: signedMoneyToString(moneyFromMinorUnits(-fee)),
              referenceType: 'FILL',
              referenceId: fill.id,
              metadata: { orderId: order.id, symbol, side: request.side },
              createdAt: now,
            },
          ];
    await tx.insert(accountLedgerEntries).values(ledgerValues);
    await calculateAndPersistAccountState(tx, request.entryId, nextCash, provider, config, now);
    const [filledOrder] = await tx
      .update(orders)
      .set({ status: 'FILLED', updatedAt: now })
      .where(eq(orders.id, order.id))
      .returning();
    return resultFromRows(filledOrder, fill);
  });
}

async function buildAccountSummary(
  tx: Transaction,
  entry: typeof tournamentEntries.$inferSelect,
  provider: MarketPriceProvider,
  config: ExecutionConfig,
  now: Date,
): Promise<AccountSummary> {
  const rows = await tx.select().from(positions).where(eq(positions.entryId, entry.id));
  const cash = parseMoney(entry.cash);
  let realized = moneyFromMinorUnits(0n);
  let totalUnrealized = moneyFromMinorUnits(0n);
  const exact = rows.map(exactPosition);
  const marks = new Map<MarketSymbol, Price>();
  const serialized: AccountSummary['positions'] = [];
  for (const position of exact) {
    realized = moneyFromMinorUnits(realized + position.realizedPnL);
    let positionUnrealized = moneyFromMinorUnits(0n);
    if (position.quantity > 0n) {
      const snapshot = await authoritativeSnapshot(provider, position.symbol, now, config);
      marks.set(position.symbol, snapshot.price);
      positionUnrealized = unrealizedPnL(position, snapshot.price);
      totalUnrealized = moneyFromMinorUnits(totalUnrealized + positionUnrealized);
    }
    serialized.push({
      symbol: position.symbol,
      quantity: quantityToString(position.quantity),
      averageEntryPrice:
        position.quantity === 0n ? '0.00000000' : priceToString(position.averageEntryPrice),
      realizedPnL: signedMoneyToString(position.realizedPnL),
      unrealizedPnL: signedMoneyToString(positionUnrealized),
    });
  }
  return {
    entryId: entry.id,
    cash: moneyToString(cash),
    realizedPnL: signedMoneyToString(realized),
    unrealizedPnL: signedMoneyToString(totalUnrealized),
    equity: signedMoneyToString(accountEquity(cash, exact, marks)),
    positions: serialized,
  };
}

export async function getAccountSummary(
  db: Database,
  provider: MarketPriceProvider,
  entryId: string,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<AccountSummary> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
    return buildAccountSummary(tx, entry, provider, config, now);
  });
}

export async function reconcileEntry(
  db: Database,
  provider: MarketPriceProvider,
  entryId: string,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<AccountSummary> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
    const summary = await buildAccountSummary(tx, entry, provider, config, now);
    const persistedPositions = await tx
      .select()
      .from(positions)
      .where(eq(positions.entryId, entryId));
    const fillHistory = await tx
      .select()
      .from(fills)
      .where(eq(fills.entryId, entryId))
      .orderBy(asc(fills.executionSequence));
    const rebuilt = new Map<MarketSymbol, ExactPosition>();
    try {
      for (const fill of fillHistory) {
        const current = rebuilt.get(fill.symbol) ?? null;
        const quantity = parseQuantity(fill.quantity);
        const fillPrice = parsePrice(fill.fillPrice);
        if (fill.side === 'BUY') {
          rebuilt.set(fill.symbol, buyPosition(current, fill.symbol, quantity, fillPrice));
        } else {
          rebuilt.set(fill.symbol, sellPosition(current, quantity, fillPrice).position);
        }
      }
    } catch (error) {
      throw new DomainError(
        'FINANCIAL_INVARIANT_VIOLATION',
        'Fill history cannot be replayed into a valid long-only position state',
        { cause: error instanceof Error ? error.message : 'Unknown replay error' },
      );
    }
    const ledger = await tx
      .select({ amount: accountLedgerEntries.amount })
      .from(accountLedgerEntries)
      .where(eq(accountLedgerEntries.entryId, entryId));
    const ledgerCash = ledger.reduce(
      (total, row) => moneyFromMinorUnits(total + parseSignedMoney(row.amount)),
      moneyFromMinorUnits(0n),
    );
    const rebuiltPositions = [...rebuilt.values()];
    const rebuiltMarks = new Map<MarketSymbol, Price>();
    let rebuiltRealized = moneyFromMinorUnits(0n);
    let rebuiltUnrealized = moneyFromMinorUnits(0n);
    for (const position of rebuiltPositions) {
      rebuiltRealized = moneyFromMinorUnits(rebuiltRealized + position.realizedPnL);
      if (position.quantity === 0n) continue;
      const snapshot = await authoritativeSnapshot(provider, position.symbol, now, config);
      rebuiltMarks.set(position.symbol, snapshot.price);
      rebuiltUnrealized = moneyFromMinorUnits(
        rebuiltUnrealized + unrealizedPnL(position, snapshot.price),
      );
    }
    const rebuiltEquity = accountEquity(ledgerCash, rebuiltPositions, rebuiltMarks);
    const mismatches: Record<string, { expected: string; actual: string }> = {};
    if (signedMoneyToString(ledgerCash) !== entry.cash)
      mismatches.cash = { expected: signedMoneyToString(ledgerCash), actual: entry.cash };
    if (signedMoneyToString(rebuiltRealized) !== entry.realizedPnL)
      mismatches.realizedPnL = {
        expected: signedMoneyToString(rebuiltRealized),
        actual: entry.realizedPnL,
      };
    if (signedMoneyToString(rebuiltUnrealized) !== entry.unrealizedPnL)
      mismatches.unrealizedPnL = {
        expected: signedMoneyToString(rebuiltUnrealized),
        actual: entry.unrealizedPnL,
      };
    if (signedMoneyToString(rebuiltEquity) !== entry.currentEquity)
      mismatches.equity = {
        expected: signedMoneyToString(rebuiltEquity),
        actual: entry.currentEquity,
      };
    const persistedBySymbol = new Map(
      persistedPositions.map((position) => [position.symbol, exactPosition(position)]),
    );
    for (const symbol of new Set([...rebuilt.keys(), ...persistedBySymbol.keys()])) {
      const expected = rebuilt.get(symbol);
      const actual = persistedBySymbol.get(symbol);
      const expectedState = expected
        ? `${quantityToString(expected.quantity)}|${expected.quantity === 0n ? '0.00000000' : priceToString(expected.averageEntryPrice)}|${signedMoneyToString(expected.realizedPnL)}`
        : 'missing';
      const actualState = actual
        ? `${quantityToString(actual.quantity)}|${actual.quantity === 0n ? '0.00000000' : priceToString(actual.averageEntryPrice)}|${signedMoneyToString(actual.realizedPnL)}`
        : 'missing';
      if (expectedState !== actualState)
        mismatches[`position:${symbol}`] = { expected: expectedState, actual: actualState };
    }
    if (Object.keys(mismatches).length > 0)
      throw new DomainError(
        'FINANCIAL_INVARIANT_VIOLATION',
        'Entry financial state does not reconcile with ledger, positions, and current marks',
        { mismatches },
      );
    return summary;
  });
}
