import type { MarketSymbol } from '@trade-the-pool/market-data';
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

export type OrderSide = 'BUY' | 'SELL';
export type ExactPosition = {
  symbol: MarketSymbol;
  quantity: Quantity;
  averageEntryPrice: Price;
  realizedPnL: Money;
};

export type FillQuote = {
  referencePrice: Price;
  fillPrice: Price;
  spreadAmount: Price;
  slippageAmount: Price;
};

export function assertTradable(status: string, tradingClosesAt: Date | null, now: Date): void {
  if (
    (status !== 'OPEN' && status !== 'ENTRY_CLOSED') ||
    !tradingClosesAt ||
    now >= tradingClosesAt
  )
    throw new DomainError(
      'TOURNAMENT_NOT_TRADABLE',
      'Tournament is not in a tradable state or its trading window has closed',
    );
}

export function assertFreshSnapshot(marketTimestamp: Date, now: Date, thresholdMs: number): void {
  const age = now.getTime() - marketTimestamp.getTime();
  if (!Number.isFinite(age) || age < 0 || age > thresholdMs)
    throw new DomainError(
      'STALE_MARKET_PRICE',
      'Authoritative market price is stale or future-dated',
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
  if (quantity <= 0n) throw new DomainError('INVALID_ORDER', 'Buy quantity must be positive');
  if (!current)
    return { symbol, quantity, averageEntryPrice: fillPrice, realizedPnL: moneyFromMinorUnits(0n) };
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

export function sellPosition(
  current: ExactPosition | null,
  quantity: Quantity,
  fillPrice: Price,
): { position: ExactPosition; realizedOnFill: Money } {
  if (!current || quantity <= 0n || quantity > current.quantity)
    throw new DomainError('INSUFFICIENT_POSITION', 'Sell quantity exceeds the owned position');
  const proceeds = priceQuantityToMoney(fillPrice, quantity);
  const costBasis = priceQuantityToMoney(current.averageEntryPrice, quantity);
  const realizedOnFill = moneyFromMinorUnits(proceeds - costBasis);
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

export function unrealizedPnL(position: ExactPosition, markPrice: Price): Money {
  return moneyFromMinorUnits(
    divideRoundHalfUp(
      (markPrice - position.averageEntryPrice) * position.quantity * 100n,
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
    equity = moneyFromMinorUnits(equity + priceQuantityToMoney(mark, position.quantity));
  }
  return equity;
}
