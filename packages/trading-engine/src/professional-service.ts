import { and, asc, count, eq, or, sql } from 'drizzle-orm';
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
  decimalToString,
  MARKET_REGISTRY,
  moneyFromMinorUnits,
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
  assertExecutionEligibleSnapshot,
  assertFreshSnapshot,
  assertTradable,
  calculateFee,
  calculateFillQuote,
  decreasePosition,
  executionSide,
  grossExposure,
  increasePosition,
  unrealizedPnL,
  type ExactPosition,
  type OrderSide,
  type PositionSide,
} from './domain.js';
import { DomainError } from './errors.js';
import {
  availableMargin,
  estimatedLiquidationPrice,
  releasedMargin,
  requiredMargin,
  shouldLiquidate,
} from './risk.js';

export type TradingOrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET';
export type StoredOrderType = TradingOrderType | 'TAKE_PROFIT' | 'STOP_LOSS' | 'LIQUIDATION';
export type TradingOrderRequest = {
  entryId: string;
  symbol: string;
  positionSide: PositionSide;
  intent: 'OPEN' | 'CLOSE';
  orderType: TradingOrderType;
  requestedNotional?: string;
  leverage?: number;
  quantity?: string;
  percentageBps?: number;
  limitPrice?: string;
  triggerPrice?: string;
  takeProfitPrice?: string | null;
  stopLossPrice?: string | null;
  idempotencyKey: string;
};

export type ProfessionalOrderResult = {
  replayed: boolean;
  order: {
    id: string;
    entryId: string;
    symbol: MarketSymbol;
    side: OrderSide;
    positionSide: PositionSide;
    intent: 'OPEN' | 'CLOSE';
    orderType: StoredOrderType;
    leverage: number;
    status: 'OPEN' | 'FILLED';
    idempotencyKey: string;
  };
  fill: null | {
    id: string;
    orderId: string;
    referencePrice: string;
    fillPrice: string;
    quantity: string;
    notional: string;
    spreadAmount: string;
    slippageAmount: string;
    feeAmount: string;
    realizedPnL: string;
    leverage: number;
    marketSource: string;
    marketTimestamp: Date;
    serverTimestamp: Date;
  };
};

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type OrderRow = typeof orders.$inferSelect;

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
  let snapshot: Awaited<ReturnType<MarketPriceProvider['getSnapshot']>>;
  try {
    snapshot = await provider.getSnapshot(symbol);
  } catch {
    throw new DomainError('STALE_MARKET_PRICE', 'Authoritative market pricing is unavailable');
  }
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
  assertExecutionEligibleSnapshot(snapshot);
  assertFreshSnapshot(snapshot.marketTimestamp, now, config.stalePriceThresholdMs);
  return snapshot;
}

function exactPosition(row: typeof positions.$inferSelect): ExactPosition {
  const quantity = parseQuantity(row.quantity);
  return {
    symbol: row.symbol,
    side: row.side,
    quantity,
    averageEntryPrice: (quantity === 0n ? 0n : parsePrice(row.averageEntryPrice)) as Price,
    realizedPnL: parseSignedMoney(row.realizedPnL),
  };
}

function serializeResult(
  order: OrderRow,
  fill: typeof fills.$inferSelect | null,
  replayed: boolean,
): ProfessionalOrderResult {
  if (order.status !== 'OPEN' && order.status !== 'FILLED')
    throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Order result is not active or filled');
  return {
    replayed,
    order: {
      id: order.id,
      entryId: order.entryId,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      intent: order.intent,
      orderType: order.orderType,
      leverage: order.leverage,
      status: order.status,
      idempotencyKey: order.idempotencyKey,
    },
    fill: fill
      ? {
          id: fill.id,
          orderId: fill.orderId,
          referencePrice: fill.referencePrice,
          fillPrice: fill.fillPrice,
          quantity: fill.quantity,
          notional: fill.notional,
          spreadAmount: fill.spreadAmount,
          slippageAmount: fill.slippageAmount,
          feeAmount: fill.feeAmount,
          realizedPnL: fill.realizedPnL,
          leverage: fill.leverage,
          marketSource: fill.marketSource,
          marketTimestamp: fill.marketTimestamp,
          serverTimestamp: fill.serverTimestamp,
        }
      : null,
  };
}

function normalizedRequest(request: TradingOrderRequest, config: ExecutionConfig) {
  const symbol = symbolFrom(request.symbol, config);
  validateIdempotencyKey(request.idempotencyKey);
  if (request.positionSide !== 'LONG' && request.positionSide !== 'SHORT')
    throw new DomainError('INVALID_ORDER', 'Position side must be LONG or SHORT');
  if (request.intent !== 'OPEN' && request.intent !== 'CLOSE')
    throw new DomainError('INVALID_ORDER', 'Order intent must be OPEN or CLOSE');
  if (!['MARKET', 'LIMIT', 'STOP_MARKET'].includes(request.orderType))
    throw new DomainError('INVALID_ORDER', 'Unsupported order type');

  let requestedNotional: string | null = null;
  let requestedQuantity: string | null = null;
  let requestedPercentageBps: number | null = null;
  if (request.intent === 'OPEN') {
    if (request.quantity !== undefined || request.percentageBps !== undefined)
      throw new DomainError('INVALID_ORDER', 'Open orders use notional sizing');
    const notional = parseMoney(request.requestedNotional ?? '');
    if (notional <= 0n || notional > config.maximumOrderNotional)
      throw new DomainError('INVALID_ORDER', 'Order notional is outside configured limits');
    requestedNotional = moneyToString(notional);
    const leverage = request.leverage ?? 1;
    if (
      !Number.isInteger(leverage) ||
      leverage < 1 ||
      leverage > MARKET_REGISTRY[symbol].maxLeverage
    )
      throw new DomainError(
        'INVALID_ORDER',
        `${symbol} supports leverage from 1x to ${MARKET_REGISTRY[symbol].maxLeverage}x`,
      );
  } else {
    if (request.requestedNotional !== undefined)
      throw new DomainError('INVALID_ORDER', 'Close orders use quantity or percentage sizing');
    const hasQuantity = request.quantity !== undefined;
    const hasPercentage = request.percentageBps !== undefined;
    if (hasQuantity === hasPercentage)
      throw new DomainError('INVALID_ORDER', 'Close requires exactly one quantity or percentage');
    if (hasQuantity) {
      const quantity = parseQuantity(request.quantity!);
      if (quantity <= 0n) throw new DomainError('INVALID_ORDER', 'Close quantity must be positive');
      requestedQuantity = quantityToString(quantity);
    } else {
      const percentage = request.percentageBps!;
      if (!Number.isInteger(percentage) || percentage <= 0 || percentage > 10_000)
        throw new DomainError('INVALID_ORDER', 'Close percentage must be 1-10000 basis points');
      requestedPercentageBps = percentage;
    }
  }

  let limitPrice: string | null = null;
  let triggerPrice: string | null = null;
  if (request.orderType === 'MARKET') {
    if (request.limitPrice !== undefined || request.triggerPrice !== undefined)
      throw new DomainError('INVALID_ORDER', 'Market orders do not accept a trigger price');
  } else if (request.orderType === 'LIMIT') {
    if (request.triggerPrice !== undefined)
      throw new DomainError('INVALID_ORDER', 'Limit orders accept only a limit price');
    limitPrice = priceToString(parsePrice(request.limitPrice ?? ''));
  } else {
    if (request.limitPrice !== undefined)
      throw new DomainError('INVALID_ORDER', 'Stop market orders accept only a stop price');
    triggerPrice = priceToString(parsePrice(request.triggerPrice ?? ''));
  }

  return {
    ...request,
    symbol,
    side: executionSide(request.positionSide, request.intent),
    requestedNotional,
    requestedQuantity,
    requestedPercentageBps,
    leverage: request.intent === 'OPEN' ? (request.leverage ?? 1) : 1,
    limitPrice,
    triggerPrice,
    takeProfitPrice:
      request.takeProfitPrice == null ? null : priceToString(parsePrice(request.takeProfitPrice)),
    stopLossPrice:
      request.stopLossPrice == null ? null : priceToString(parsePrice(request.stopLossPrice)),
  };
}

function sameLogicalRequest(
  order: OrderRow,
  request: ReturnType<typeof normalizedRequest>,
): boolean {
  return (
    order.symbol === request.symbol &&
    order.side === request.side &&
    order.positionSide === request.positionSide &&
    order.intent === request.intent &&
    order.orderType === request.orderType &&
    (request.intent === 'CLOSE' || order.leverage === request.leverage) &&
    order.requestedNotional === request.requestedNotional &&
    order.requestedQuantity === request.requestedQuantity &&
    order.requestedPercentageBps === request.requestedPercentageBps &&
    order.limitPrice === request.limitPrice &&
    order.triggerPrice === request.triggerPrice
  );
}

function validatesProtection(
  side: PositionSide,
  reference: Price,
  takeProfit: Price | null,
  stopLoss: Price | null,
) {
  if (
    takeProfit !== null &&
    ((side === 'LONG' && takeProfit <= reference) || (side === 'SHORT' && takeProfit >= reference))
  )
    throw new DomainError('INVALID_ORDER', 'Take-profit price is on the wrong side of the market');
  if (
    stopLoss !== null &&
    ((side === 'LONG' && stopLoss >= reference) || (side === 'SHORT' && stopLoss <= reference))
  )
    throw new DomainError('INVALID_ORDER', 'Stop-loss price is on the wrong side of the market');
}

function triggerSatisfied(order: OrderRow, mark: Price): boolean {
  if (order.orderType === 'MARKET' || order.orderType === 'LIQUIDATION') return true;
  if (order.orderType === 'LIMIT') {
    const limit = parsePrice(order.limitPrice!);
    return order.side === 'BUY' ? mark <= limit : mark >= limit;
  }
  const trigger = parsePrice(order.triggerPrice!);
  if (order.orderType === 'TAKE_PROFIT')
    return order.positionSide === 'LONG' ? mark >= trigger : mark <= trigger;
  if (order.orderType === 'STOP_LOSS')
    return order.positionSide === 'LONG' ? mark <= trigger : mark >= trigger;
  return order.side === 'BUY' ? mark >= trigger : mark <= trigger;
}

async function loadAccountBasis(
  tx: Transaction,
  entryId: string,
  provider: MarketPriceProvider,
  config: ExecutionConfig,
  now: Date,
  currentSnapshot?: Awaited<ReturnType<typeof authoritativeSnapshot>>,
) {
  const rows = await tx.select().from(positions).where(eq(positions.entryId, entryId));
  const exact = rows.map(exactPosition);
  const marks = new Map<MarketSymbol, Price>();
  for (const position of exact) {
    if (position.quantity === 0n) continue;
    const snapshot =
      currentSnapshot?.symbol === position.symbol
        ? currentSnapshot
        : await authoritativeSnapshot(provider, position.symbol, now, config);
    marks.set(position.symbol, snapshot.price);
  }
  return { exact, marks };
}

async function loadMarginState(
  tx: Transaction,
  entryId: string,
  cash: Money,
  provider: MarketPriceProvider,
  config: ExecutionConfig,
  now: Date,
  currentSnapshot?: Awaited<ReturnType<typeof authoritativeSnapshot>>,
  excludeOrderId?: string,
) {
  const basis = await loadAccountBasis(tx, entryId, provider, config, now, currentSnapshot);
  const positionRows = await tx.select().from(positions).where(eq(positions.entryId, entryId));
  const marginUsed = moneyFromMinorUnits(
    positionRows.reduce(
      (total, position) =>
        total + (parseQuantity(position.quantity) > 0n ? parseMoney(position.marginUsed) : 0n),
      0n,
    ),
  );
  const pending = await tx
    .select({
      id: orders.id,
      requestedNotional: orders.requestedNotional,
      leverage: orders.leverage,
    })
    .from(orders)
    .where(and(eq(orders.entryId, entryId), eq(orders.intent, 'OPEN'), eq(orders.status, 'OPEN')));
  let reservedMargin = moneyFromMinorUnits(0n);
  let reservedNotional = moneyFromMinorUnits(0n);
  for (const order of pending) {
    if (order.id === excludeOrderId || order.requestedNotional === null) continue;
    const notional = parseMoney(order.requestedNotional);
    reservedNotional = moneyFromMinorUnits(reservedNotional + notional);
    reservedMargin = moneyFromMinorUnits(reservedMargin + requiredMargin(notional, order.leverage));
  }
  const equity = accountEquity(cash, basis.exact, basis.marks);
  return {
    ...basis,
    equity,
    marginUsed,
    reservedMargin,
    reservedNotional,
    freeMargin: availableMargin(equity, marginUsed, reservedMargin),
    grossExposure: grossExposure(basis.exact, basis.marks),
  };
}

async function persistAccountState(
  tx: Transaction,
  entryId: string,
  cash: Money,
  provider: MarketPriceProvider,
  config: ExecutionConfig,
  now: Date,
  currentSnapshot?: Awaited<ReturnType<typeof authoritativeSnapshot>>,
): Promise<Money> {
  const { exact, marks } = await loadAccountBasis(
    tx,
    entryId,
    provider,
    config,
    now,
    currentSnapshot,
  );
  let realized = moneyFromMinorUnits(0n);
  let unrealized = moneyFromMinorUnits(0n);
  for (const position of exact) {
    realized = moneyFromMinorUnits(realized + position.realizedPnL);
    if (position.quantity > 0n)
      unrealized = moneyFromMinorUnits(
        unrealized + unrealizedPnL(position, marks.get(position.symbol)!),
      );
  }
  const equity = accountEquity(cash, exact, marks);
  const busted = equity <= 0n;
  const [currentEntry] = await tx
    .select({ isBusted: tournamentEntries.isBusted, bustedAt: tournamentEntries.bustedAt })
    .from(tournamentEntries)
    .where(eq(tournamentEntries.id, entryId));
  await tx
    .update(tournamentEntries)
    .set({
      cash: signedMoneyToString(cash),
      realizedPnL: signedMoneyToString(realized),
      unrealizedPnL: signedMoneyToString(unrealized),
      currentEquity: signedMoneyToString(equity),
      isBusted: currentEntry?.isBusted || busted,
      bustedAt: currentEntry?.bustedAt ?? (busted ? now : null),
      updatedAt: now,
    })
    .where(eq(tournamentEntries.id, entryId));
  if (busted)
    await tx
      .update(orders)
      .set({
        status: 'EXPIRED',
        cancellationReason: 'Entry busted',
        cancelledAt: now,
        updatedAt: now,
      })
      .where(and(eq(orders.entryId, entryId), eq(orders.status, 'OPEN')));
  return equity;
}

async function insertProtectionOrders(
  tx: Transaction,
  parent: OrderRow,
  takeProfitPrice: string | null,
  stopLossPrice: string | null,
  now: Date,
): Promise<void> {
  const values: Array<typeof orders.$inferInsert> = [];
  const base = {
    entryId: parent.entryId,
    symbol: parent.symbol,
    side: executionSide(parent.positionSide, 'CLOSE'),
    positionSide: parent.positionSide,
    leverage: parent.leverage,
    intent: 'CLOSE' as const,
    requestedNotional: null,
    requestedQuantity: null,
    requestedPercentageBps: 10_000,
    limitPrice: null,
    status: 'OPEN' as const,
    parentOrderId: parent.id,
    ocoGroupId: parent.id,
    createdAt: now,
    updatedAt: now,
  };
  if (takeProfitPrice)
    values.push({
      ...base,
      orderType: 'TAKE_PROFIT',
      triggerPrice: takeProfitPrice,
      idempotencyKey: `protection:${parent.id}:tp`,
    });
  if (stopLossPrice)
    values.push({
      ...base,
      orderType: 'STOP_LOSS',
      triggerPrice: stopLossPrice,
      idempotencyKey: `protection:${parent.id}:sl`,
    });
  if (values.length) await tx.insert(orders).values(values);
}

async function executePersistedOrder(
  tx: Transaction,
  provider: MarketPriceProvider,
  order: OrderRow,
  now: Date,
  config: ExecutionConfig,
  protection?: { takeProfitPrice: string | null; stopLossPrice: string | null },
): Promise<{ order: OrderRow; fill: typeof fills.$inferSelect }> {
  const [entry] = await tx
    .select()
    .from(tournamentEntries)
    .where(eq(tournamentEntries.id, order.entryId))
    .for('update');
  if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
  if (entry.isBusted && order.intent === 'OPEN')
    throw new DomainError('ENTRY_BUSTED', 'This tournament entry has been busted and cannot trade');
  const [tournament] = await tx
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, entry.tournamentId));
  if (!tournament)
    throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Entry tournament does not exist');
  assertTradable(
    tournament.status,
    {
      registrationOpensAt: tournament.registrationOpensAt,
      tradingStartsAt: tournament.tradingStartsAt,
      entryClosesAt: tournament.entryClosesAt,
      tradingClosesAt: tournament.tradingClosesAt,
    },
    now,
  );

  const snapshot = await authoritativeSnapshot(provider, order.symbol, now, config);
  const [positionRow] = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.entryId, order.entryId), eq(positions.symbol, order.symbol)));
  const currentPosition = positionRow ? exactPosition(positionRow) : null;
  const cash = parseSignedMoney(entry.cash);

  let quantity: Quantity;
  let referenceNotional: Money;
  if (order.intent === 'OPEN') {
    referenceNotional = parseMoney(order.requestedNotional!);
    const preliminary = calculateFillQuote(
      snapshot.price,
      order.side,
      referenceNotional,
      order.symbol,
      config,
    );
    quantity = quantityForMoney(referenceNotional, preliminary.fillPrice);
  } else {
    if (!currentPosition || currentPosition.side !== order.positionSide)
      throw new DomainError('INSUFFICIENT_POSITION', 'Position no longer exists');
    quantity = order.requestedQuantity
      ? parseQuantity(order.requestedQuantity)
      : (((currentPosition.quantity * BigInt(order.requestedPercentageBps!)) /
          10_000n) as Quantity);
    if (quantity <= 0n || quantity > currentPosition.quantity)
      throw new DomainError('INSUFFICIENT_POSITION', 'Close quantity exceeds the open position');
    referenceNotional = priceQuantityToMoney(snapshot.price, quantity);
  }

  let quote = calculateFillQuote(
    snapshot.price,
    order.side,
    referenceNotional,
    order.symbol,
    config,
  );
  if (order.orderType === 'LIMIT') {
    const limit = parsePrice(order.limitPrice!);
    if (order.side === 'BUY' && quote.fillPrice > limit) quote = { ...quote, fillPrice: limit };
    if (order.side === 'SELL' && quote.fillPrice < limit) quote = { ...quote, fillPrice: limit };
  }
  if (order.intent === 'OPEN') quantity = quantityForMoney(referenceNotional, quote.fillPrice);
  const notional = priceQuantityToMoney(quote.fillPrice, quantity);
  if (quantity <= 0n || notional <= 0n)
    throw new DomainError('INVALID_ORDER', 'Order is too small to produce an exact fill');
  const fee = calculateFee(notional, config);

  if (order.intent === 'OPEN') {
    if (
      currentPosition &&
      currentPosition.quantity > 0n &&
      positionRow?.leverage !== order.leverage
    )
      throw new DomainError(
        'POSITION_LEVERAGE_CONFLICT',
        `Existing ${order.symbol} position uses ${positionRow?.leverage}x leverage`,
      );
    const risk = await loadMarginState(
      tx,
      order.entryId,
      cash,
      provider,
      config,
      now,
      snapshot,
      order.id,
    );
    const initialMargin = requiredMargin(notional, order.leverage);
    if (initialMargin + fee > risk.freeMargin)
      throw new DomainError(
        'INSUFFICIENT_MARGIN',
        'Available simulated margin does not cover this order and fee',
      );
    const maximumGrossExposure = risk.equity * BigInt(config.maximumGrossLeverage);
    if (risk.grossExposure + risk.reservedNotional + notional > maximumGrossExposure)
      throw new DomainError(
        'INSUFFICIENT_MARGIN',
        `Gross exposure cannot exceed ${config.maximumGrossLeverage}x current equity`,
      );
  }

  let nextPosition: ExactPosition;
  let realizedOnFill = moneyFromMinorUnits(0n);
  let nextMargin = moneyFromMinorUnits(0n);
  let effectiveLeverage = order.leverage;
  if (order.intent === 'OPEN') {
    nextPosition = increasePosition(
      currentPosition,
      order.symbol,
      order.positionSide,
      quantity,
      quote.fillPrice,
    );
    nextMargin = moneyFromMinorUnits(
      parseMoney(positionRow?.marginUsed ?? '0.00') + requiredMargin(notional, order.leverage),
    );
  } else {
    const decreased = decreasePosition(
      currentPosition,
      order.positionSide,
      quantity,
      quote.fillPrice,
    );
    nextPosition = decreased.position;
    realizedOnFill = decreased.realizedOnFill;
    effectiveLeverage = positionRow?.leverage ?? order.leverage;
    const currentMargin = parseMoney(positionRow?.marginUsed ?? '0.00');
    nextMargin = moneyFromMinorUnits(
      currentMargin - releasedMargin(currentMargin, quantity, currentPosition!.quantity),
    );
  }
  const nextCash = moneyFromMinorUnits(
    order.side === 'BUY' ? cash - notional - fee : cash + notional - fee,
  );
  const liquidationPrice = estimatedLiquidationPrice(
    {
      side: nextPosition.side,
      quantity: nextPosition.quantity,
      averageEntryPrice: nextPosition.averageEntryPrice,
      leverage: effectiveLeverage,
      marginUsed: nextMargin,
    },
    config.maintenanceMarginBasisPoints,
  );

  await tx
    .insert(positions)
    .values({
      entryId: order.entryId,
      symbol: order.symbol,
      side: nextPosition.side,
      leverage: effectiveLeverage,
      quantity: quantityToString(nextPosition.quantity),
      averageEntryPrice:
        nextPosition.quantity === 0n ? '0.00000000' : priceToString(nextPosition.averageEntryPrice),
      realizedPnL: signedMoneyToString(nextPosition.realizedPnL),
      marginUsed: moneyToString(nextMargin),
      liquidationPrice: liquidationPrice ? priceToString(liquidationPrice) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [positions.entryId, positions.symbol],
      set: {
        side: nextPosition.side,
        leverage: effectiveLeverage,
        quantity: quantityToString(nextPosition.quantity),
        averageEntryPrice:
          nextPosition.quantity === 0n
            ? '0.00000000'
            : priceToString(nextPosition.averageEntryPrice),
        realizedPnL: signedMoneyToString(nextPosition.realizedPnL),
        marginUsed: moneyToString(nextMargin),
        liquidationPrice: liquidationPrice ? priceToString(liquidationPrice) : null,
        updatedAt: now,
      },
    });

  const [{ value: fillCount }] = await tx
    .select({ value: count() })
    .from(fills)
    .where(eq(fills.entryId, order.entryId));
  const [fill] = await tx
    .insert(fills)
    .values({
      orderId: order.id,
      entryId: order.entryId,
      executionSequence: Number(fillCount) + 1,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      intent: order.intent,
      leverage: effectiveLeverage,
      referencePrice: priceToString(quote.referencePrice),
      fillPrice: priceToString(quote.fillPrice),
      quantity: quantityToString(quantity),
      notional: moneyToString(notional),
      spreadAmount: decimalToString(quote.spreadAmount),
      slippageAmount: decimalToString(quote.slippageAmount),
      feeAmount: moneyToString(fee),
      realizedPnL: signedMoneyToString(realizedOnFill),
      marketSource: snapshot.source,
      marketTimestamp: snapshot.marketTimestamp,
      serverTimestamp: now,
      createdAt: now,
    })
    .returning();

  const cashLedger = {
    entryId: order.entryId,
    type: order.side === 'BUY' ? ('TRADE_CASH_DEBIT' as const) : ('TRADE_CASH_CREDIT' as const),
    amount:
      order.side === 'BUY'
        ? signedMoneyToString(moneyFromMinorUnits(-notional))
        : moneyToString(notional),
    referenceType: 'FILL',
    referenceId: fill.id,
    metadata: {
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      intent: order.intent,
      leverage: effectiveLeverage,
      marginUsed: moneyToString(nextMargin),
    },
    createdAt: now,
  };
  await tx.insert(accountLedgerEntries).values([
    cashLedger,
    {
      entryId: order.entryId,
      type: 'TRADING_FEE',
      amount: signedMoneyToString(moneyFromMinorUnits(-fee)),
      referenceType: 'FILL',
      referenceId: fill.id,
      metadata: {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        intent: order.intent,
        leverage: effectiveLeverage,
        marginUsed: moneyToString(nextMargin),
      },
      createdAt: now,
    },
  ]);

  await persistAccountState(tx, order.entryId, nextCash, provider, config, now, snapshot);
  const [filledOrder] = await tx
    .update(orders)
    .set({ status: 'FILLED', filledAt: now, updatedAt: now })
    .where(eq(orders.id, order.id))
    .returning();

  if (order.intent === 'OPEN' && protection)
    await insertProtectionOrders(
      tx,
      filledOrder,
      protection.takeProfitPrice,
      protection.stopLossPrice,
      now,
    );
  if (order.intent === 'CLOSE' && nextPosition.quantity === 0n)
    await tx
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancellationReason: 'Position closed',
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.entryId, order.entryId),
          eq(orders.symbol, order.symbol),
          eq(orders.positionSide, order.positionSide),
          eq(orders.intent, 'CLOSE'),
          eq(orders.status, 'OPEN'),
        ),
      );
  return { order: filledOrder, fill };
}

export async function submitTradingOrder(
  db: Database,
  provider: MarketPriceProvider,
  request: TradingOrderRequest,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<ProfessionalOrderResult> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  let normalized: ReturnType<typeof normalizedRequest>;
  try {
    normalized = normalizedRequest(request, config);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      'INVALID_ORDER',
      error instanceof Error ? error.message : 'Invalid order',
    );
  }

  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, normalized.entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
    if (entry.isBusted)
      throw new DomainError(
        'ENTRY_BUSTED',
        'This tournament entry has been busted and cannot trade',
      );
    const [existing] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.entryId, normalized.entryId),
          eq(orders.idempotencyKey, normalized.idempotencyKey),
        ),
      );
    if (existing) {
      if (!sameLogicalRequest(existing, normalized))
        throw new DomainError(
          'DUPLICATE_ORDER_CONFLICT',
          'Idempotency key was already used for a different logical order',
        );
      const [fill] = await tx.select().from(fills).where(eq(fills.orderId, existing.id));
      return serializeResult(existing, fill ?? null, true);
    }

    const [tournament] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, entry.tournamentId));
    if (!tournament)
      throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Entry tournament does not exist');
    assertTradable(
      tournament.status,
      {
        registrationOpensAt: tournament.registrationOpensAt,
        tradingStartsAt: tournament.tradingStartsAt,
        entryClosesAt: tournament.entryClosesAt,
        tradingClosesAt: tournament.tradingClosesAt,
      },
      now,
    );
    const snapshot = await authoritativeSnapshot(provider, normalized.symbol, now, config);
    validatesProtection(
      normalized.positionSide,
      snapshot.price,
      normalized.takeProfitPrice ? parsePrice(normalized.takeProfitPrice) : null,
      normalized.stopLossPrice ? parsePrice(normalized.stopLossPrice) : null,
    );

    let effectiveLeverage = normalized.leverage;
    if (normalized.intent === 'CLOSE') {
      const [position] = await tx
        .select({ leverage: positions.leverage })
        .from(positions)
        .where(
          and(eq(positions.entryId, normalized.entryId), eq(positions.symbol, normalized.symbol)),
        );
      effectiveLeverage = position?.leverage ?? 1;
    } else {
      const cash = parseSignedMoney(entry.cash);
      const risk = await loadMarginState(tx, entry.id, cash, provider, config, now, snapshot);
      const notional = parseMoney(normalized.requestedNotional!);
      const initialMargin = requiredMargin(notional, effectiveLeverage);
      const fee = calculateFee(notional, config);
      if (initialMargin + fee > risk.freeMargin)
        throw new DomainError(
          'INSUFFICIENT_MARGIN',
          'Available simulated margin does not cover this order and fee',
        );
      if (
        risk.grossExposure + risk.reservedNotional + notional >
        risk.equity * BigInt(config.maximumGrossLeverage)
      )
        throw new DomainError(
          'INSUFFICIENT_MARGIN',
          `Gross exposure cannot exceed ${config.maximumGrossLeverage}x current equity`,
        );
    }

    const [created] = await tx
      .insert(orders)
      .values({
        entryId: normalized.entryId,
        symbol: normalized.symbol,
        side: normalized.side,
        positionSide: normalized.positionSide,
        intent: normalized.intent,
        orderType: normalized.orderType,
        leverage: effectiveLeverage,
        requestedNotional: normalized.requestedNotional,
        requestedQuantity: normalized.requestedQuantity,
        requestedPercentageBps: normalized.requestedPercentageBps,
        limitPrice: normalized.limitPrice,
        triggerPrice: normalized.triggerPrice,
        status: normalized.orderType === 'MARKET' ? 'PENDING' : 'OPEN',
        idempotencyKey: normalized.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (normalized.orderType === 'MARKET' || triggerSatisfied(created, snapshot.price)) {
      const executing =
        created.status === 'OPEN'
          ? (
              await tx
                .update(orders)
                .set({ status: 'TRIGGERED', triggeredAt: now, updatedAt: now })
                .where(eq(orders.id, created.id))
                .returning()
            )[0]
          : created;
      const result = await executePersistedOrder(tx, provider, executing, now, config, {
        takeProfitPrice: normalized.takeProfitPrice,
        stopLossPrice: normalized.stopLossPrice,
      });
      return serializeResult(result.order, result.fill, false);
    }
    return serializeResult(created, null, false);
  });
}

/** Server-authoritative isolated-position liquidation pass for one market tick. */
export async function processLiquidations(
  db: Database,
  provider: MarketPriceProvider,
  symbolValue: string,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<ProfessionalOrderResult[]> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  const symbol = symbolFrom(symbolValue, config);
  const snapshot = await authoritativeSnapshot(provider, symbol, now, config);
  const candidates = await db
    .select({ entryId: positions.entryId })
    .from(positions)
    .where(
      and(
        eq(positions.symbol, symbol),
        sql`${positions.quantity} > 0`,
        sql`${positions.liquidationPrice} IS NOT NULL`,
      ),
    );
  const results: ProfessionalOrderResult[] = [];
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(tournamentEntries)
        .where(eq(tournamentEntries.id, candidate.entryId))
        .for('update');
      if (!entry) return null;
      const [position] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.entryId, candidate.entryId), eq(positions.symbol, symbol)))
        .for('update');
      if (
        !position ||
        parseQuantity(position.quantity) <= 0n ||
        position.liquidationPrice === null ||
        !shouldLiquidate(position.side, snapshot.price, parsePrice(position.liquidationPrice))
      )
        return null;
      const idempotencyKey = `liquidation:${symbol}:${position.updatedAt.getTime()}`;
      const [existing] = await tx
        .select()
        .from(orders)
        .where(
          and(eq(orders.entryId, candidate.entryId), eq(orders.idempotencyKey, idempotencyKey)),
        );
      if (existing) {
        const [fill] = await tx.select().from(fills).where(eq(fills.orderId, existing.id));
        return fill ? serializeResult(existing, fill, true) : null;
      }
      const [order] = await tx
        .insert(orders)
        .values({
          entryId: candidate.entryId,
          symbol,
          side: executionSide(position.side, 'CLOSE'),
          positionSide: position.side,
          intent: 'CLOSE',
          orderType: 'LIQUIDATION',
          leverage: position.leverage,
          requestedPercentageBps: 10_000,
          status: 'TRIGGERED',
          idempotencyKey,
          triggeredAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const executed = await executePersistedOrder(tx, provider, order, now, config);
      return serializeResult(executed.order, executed.fill, false);
    });
    if (result) results.push(result);
  }
  return results;
}

export async function processConditionalOrders(
  db: Database,
  provider: MarketPriceProvider,
  symbolValue: string,
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<ProfessionalOrderResult[]> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  const symbol = symbolFrom(symbolValue, config);
  const candidates = await db
    .select({ id: orders.id, entryId: orders.entryId })
    .from(orders)
    .where(and(eq(orders.symbol, symbol), eq(orders.status, 'OPEN')))
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const results: ProfessionalOrderResult[] = [];
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(tournamentEntries)
        .where(eq(tournamentEntries.id, candidate.entryId))
        .for('update');
      if (!entry) return null;
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, candidate.id))
        .for('update');
      if (!order || order.status !== 'OPEN') return null;
      const [tournament] = await tx
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, entry.tournamentId));
      if (!tournament)
        throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Entry tournament does not exist');
      try {
        assertTradable(
          tournament.status,
          {
            registrationOpensAt: tournament.registrationOpensAt,
            tradingStartsAt: tournament.tradingStartsAt,
            entryClosesAt: tournament.entryClosesAt,
            tradingClosesAt: tournament.tradingClosesAt,
          },
          now,
        );
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'TOURNAMENT_NOT_TRADABLE')
          throw error;
        await tx
          .update(orders)
          .set({
            status: 'EXPIRED',
            cancellationReason: 'Tournament trading closed',
            cancelledAt: now,
            updatedAt: now,
          })
          .where(eq(orders.id, order.id));
        return null;
      }
      const snapshot = await authoritativeSnapshot(provider, symbol, now, config);
      if (!triggerSatisfied(order, snapshot.price)) return null;
      const [triggered] = await tx
        .update(orders)
        .set({ status: 'TRIGGERED', triggeredAt: now, updatedAt: now })
        .where(eq(orders.id, order.id))
        .returning();
      try {
        const executed = await executePersistedOrder(tx, provider, triggered, now, config);
        return serializeResult(executed.order, executed.fill, false);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'STALE_MARKET_PRICE') throw error;
        const reason =
          error instanceof DomainError ? error.message : 'Conditional execution failed';
        await tx
          .update(orders)
          .set({ status: 'REJECTED', rejectionReason: reason, updatedAt: now })
          .where(eq(orders.id, order.id));
        return null;
      }
    });
    if (result) results.push(result);
  }
  return results;
}

export async function cancelTradingOrder(
  db: Database,
  entryId: string,
  orderId: string,
  now = new Date(),
): Promise<OrderRow> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: tournamentEntries.id })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.entryId, entryId)))
      .for('update');
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 'Order does not exist');
    if (order.status !== 'OPEN')
      throw new DomainError('ORDER_NOT_CANCELLABLE', 'Only open orders can be cancelled');
    const [cancelled] = await tx
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancellationReason: 'Cancelled by trader',
        cancelledAt: now,
        updatedAt: now,
      })
      .where(eq(orders.id, order.id))
      .returning();
    return cancelled;
  });
}

export async function setPositionProtection(
  db: Database,
  provider: MarketPriceProvider,
  input: {
    entryId: string;
    symbol: string;
    takeProfitPrice: string | null;
    stopLossPrice: string | null;
    idempotencyKey: string;
  },
  options: { config?: ExecutionConfig; now?: Date } = {},
): Promise<OrderRow[]> {
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const now = options.now ?? new Date();
  const symbol = symbolFrom(input.symbol, config);
  validateIdempotencyKey(input.idempotencyKey);
  const takeProfit = input.takeProfitPrice
    ? priceToString(parsePrice(input.takeProfitPrice))
    : null;
  const stopLoss = input.stopLossPrice ? priceToString(parsePrice(input.stopLossPrice)) : null;
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: tournamentEntries.id })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, input.entryId))
      .for('update');
    if (!entry) throw new DomainError('ENTRY_NOT_FOUND', 'Tournament entry does not exist');
    const replayPrefix = `protection:${input.idempotencyKey.slice(0, 90)}`;
    const replay = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.entryId, input.entryId),
          or(
            eq(orders.idempotencyKey, `${replayPrefix}:tp`),
            eq(orders.idempotencyKey, `${replayPrefix}:sl`),
          ),
        ),
      );
    if (replay.length) return replay;
    const [positionRow] = await tx
      .select()
      .from(positions)
      .where(and(eq(positions.entryId, input.entryId), eq(positions.symbol, symbol)))
      .for('update');
    if (!positionRow || parseQuantity(positionRow.quantity) === 0n)
      throw new DomainError('INSUFFICIENT_POSITION', 'Position no longer exists');
    const snapshot = await authoritativeSnapshot(provider, symbol, now, config);
    validatesProtection(
      positionRow.side,
      snapshot.price,
      takeProfit ? parsePrice(takeProfit) : null,
      stopLoss ? parsePrice(stopLoss) : null,
    );
    await tx
      .update(orders)
      .set({
        status: 'CANCELLED',
        cancellationReason: 'Protection replaced',
        cancelledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(orders.entryId, input.entryId),
          eq(orders.symbol, symbol),
          eq(orders.intent, 'CLOSE'),
          eq(orders.status, 'OPEN'),
          or(eq(orders.orderType, 'TAKE_PROFIT'), eq(orders.orderType, 'STOP_LOSS')),
        ),
      );
    const values: Array<typeof orders.$inferInsert> = [];
    const base = {
      entryId: input.entryId,
      symbol,
      side: executionSide(positionRow.side, 'CLOSE'),
      positionSide: positionRow.side,
      leverage: positionRow.leverage,
      intent: 'CLOSE' as const,
      requestedPercentageBps: 10_000,
      status: 'OPEN' as const,
      createdAt: now,
      updatedAt: now,
    };
    if (takeProfit)
      values.push({
        ...base,
        orderType: 'TAKE_PROFIT',
        triggerPrice: takeProfit,
        idempotencyKey: `${replayPrefix}:tp`,
      });
    if (stopLoss)
      values.push({
        ...base,
        orderType: 'STOP_LOSS',
        triggerPrice: stopLoss,
        idempotencyKey: `${replayPrefix}:sl`,
      });
    return values.length ? tx.insert(orders).values(values).returning() : [];
  });
}
