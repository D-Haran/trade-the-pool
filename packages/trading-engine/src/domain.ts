import type { MarketPriceSnapshot, MarketSymbol } from '@trade-the-pool/market-data';
import {
  DECIMAL_SCALE,
  applyBasisPoints,
  divideRoundHalfUp,
  moneyFromMinorUnits,
  priceQuantityToMoney,
  weightedAveragePrice,
  type Money,
  type Price,
  type Quantity,
} from '@trade-the-pool/shared';
import type { ExecutionConfig } from './config.js';
import { DomainError } from './errors.js';
import {
  assertTradingWindow,
  type TournamentSchedule,
  type TournamentStatus,
} from './lifecycle.js';

export type OrderSide = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';
export type ExactPosition = {
  symbol: MarketSymbol;
  side: PositionSide;
  quantity: Quantity;
  averageEntryPrice: Price;
  realizedPnL: Money;
};

export function executionSide(positionSide: PositionSide, intent: 'OPEN' | 'CLOSE'): OrderSide {
  return positionSide === 'LONG'
    ? intent === 'OPEN'
      ? 'BUY'
      : 'SELL'
    : intent === 'OPEN'
      ? 'SELL'
      : 'BUY';
}

export function increasePosition(
  current: ExactPosition | null,
  symbol: MarketSymbol,
  side: PositionSide,
  quantity: Quantity,
  fillPrice: Price,
): ExactPosition {
  if (quantity <= 0n) throw new DomainError('INVALID_ORDER', 'Position quantity must be positive');
  if (current && current.quantity > 0n && current.side !== side)
    throw new DomainError(
      'POSITION_SIDE_CONFLICT',
      `Close the existing ${current.side.toLowerCase()} position before opening ${side.toLowerCase()}`,
    );
  if (!current || current.quantity === 0n)
    return {
      symbol,
      side,
      quantity,
      averageEntryPrice: fillPrice,
      realizedPnL: current?.realizedPnL ?? moneyFromMinorUnits(0n),
    };
  return {
    ...current,
    quantity: (current.quantity + quantity) as Quantity,
    averageEntryPrice: weightedAveragePrice(
      current.averageEntryPrice,
      current.quantity,
      fillPrice,
      quantity,
    ),
  };
}

export function decreasePosition(
  current: ExactPosition | null,
  side: PositionSide,
  quantity: Quantity,
  fillPrice: Price,
): { position: ExactPosition; realizedOnFill: Money } {
  if (!current || current.side !== side || quantity <= 0n || quantity > current.quantity)
    throw new DomainError('INSUFFICIENT_POSITION', 'Close quantity exceeds the open position');
  const exitValue = priceQuantityToMoney(fillPrice, quantity);
  const entryValue = priceQuantityToMoney(current.averageEntryPrice, quantity);
  const realizedOnFill = moneyFromMinorUnits(
    side === 'LONG' ? exitValue - entryValue : entryValue - exitValue,
  );
  const remaining = (current.quantity - quantity) as Quantity;
  return {
    realizedOnFill,
    position: {
      ...current,
      quantity: remaining,
      averageEntryPrice: (remaining === 0n ? 0n : current.averageEntryPrice) as Price,
      realizedPnL: moneyFromMinorUnits(current.realizedPnL + realizedOnFill),
    },
  };
}

export type FillQuote = {
  referencePrice: Price;
  fillPrice: Price;
  spreadAmount: Price;
  slippageAmount: Price;
};

export function assertTradable(
  status: TournamentStatus,
  schedule: TournamentSchedule,
  now: Date,
): void {
  assertTradingWindow(status, schedule, now);
}

export function assertFreshSnapshot(marketTimestamp: Date, now: Date, thresholdMs: number): void {
  const age = now.getTime() - marketTimestamp.getTime();
  if (!Number.isFinite(age) || age < 0 || age > thresholdMs)
    throw new DomainError(
      'STALE_MARKET_PRICE',
      'Authoritative market price is stale or future-dated',
    );
}

export function assertExecutionEligibleSnapshot(snapshot: MarketPriceSnapshot): void {
  if (
    snapshot.executionEligible === false ||
    ['STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED'].includes(snapshot.status ?? '')
  )
    throw new DomainError(
      'STALE_MARKET_PRICE',
      'Authoritative market pricing is stale, degraded, or unavailable',
    );
}

export function calculateFillQuote(
  referencePrice: Price,
  side: OrderSide,
  referenceNotional: Money,
  symbol: MarketSymbol,
  config: ExecutionConfig,
): FillQuote {
  if (!config.allowedSymbols.includes(symbol))
    throw new DomainError('UNSUPPORTED_SYMBOL', `Unsupported symbol: ${symbol}`);
  const liquidity = config.simulatedLiquidity[symbol];
  if (liquidity <= 0n)
    throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Liquidity must be positive');
  const spreadAmount = divideRoundHalfUp(
    referencePrice * config.spreadBasisPoints,
    10_000n,
  ) as Price;
  const boundedNotional = referenceNotional > liquidity ? liquidity : referenceNotional;
  const slippageAmount = divideRoundHalfUp(
    referencePrice * config.maximumSlippageBasisPoints * boundedNotional,
    10_000n * liquidity,
  ) as Price;
  const adjustment = spreadAmount + slippageAmount;
  const fillPrice = (
    side === 'BUY' ? referencePrice + adjustment : referencePrice - adjustment
  ) as Price;
  if (fillPrice <= 0n)
    throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Fill price must remain positive');
  return { referencePrice, fillPrice, spreadAmount, slippageAmount };
}

export function calculateFee(notional: Money, config: ExecutionConfig): Money {
  return applyBasisPoints(notional, config.tradingFeeBasisPoints);
}

export function buyPosition(
  current: ExactPosition | null,
  symbol: MarketSymbol,
  quantity: Quantity,
  fillPrice: Price,
): ExactPosition {
  return increasePosition(current, symbol, 'LONG', quantity, fillPrice);
}

export function sellPosition(
  current: ExactPosition | null,
  quantity: Quantity,
  fillPrice: Price,
): { position: ExactPosition; realizedOnFill: Money } {
  return decreasePosition(current, 'LONG', quantity, fillPrice);
}

export function unrealizedPnL(position: ExactPosition, markPrice: Price): Money {
  return moneyFromMinorUnits(
    divideRoundHalfUp(
      (position.side === 'LONG'
        ? markPrice - position.averageEntryPrice
        : position.averageEntryPrice - markPrice) *
        position.quantity *
        100n,
      DECIMAL_SCALE ** 2n,
    ),
  );
}

export function accountEquity(
  cash: Money,
  positions: readonly ExactPosition[],
  marks: ReadonlyMap<MarketSymbol, Price>,
): Money {
  let equity = cash;
  for (const position of positions) {
    if (position.quantity === 0n) continue;
    const mark = marks.get(position.symbol);
    if (!mark)
      throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', `Missing mark for ${position.symbol}`);
    const marketValue = priceQuantityToMoney(mark, position.quantity);
    equity = moneyFromMinorUnits(
      position.side === 'LONG' ? equity + marketValue : equity - marketValue,
    );
  }
  return equity;
}

export function grossExposure(
  positions: readonly ExactPosition[],
  marks: ReadonlyMap<MarketSymbol, Price>,
): Money {
  let exposure = moneyFromMinorUnits(0n);
  for (const position of positions) {
    if (position.quantity === 0n) continue;
    const mark = marks.get(position.symbol);
    if (!mark)
      throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', `Missing mark for ${position.symbol}`);
    exposure = moneyFromMinorUnits(exposure + priceQuantityToMoney(mark, position.quantity));
  }
  return exposure;
}
