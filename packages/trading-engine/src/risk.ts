import {
  DECIMAL_SCALE,
  MONEY_SCALE,
  applyBasisPoints,
  divideRoundHalfUp,
  moneyFromMinorUnits,
  type Money,
  type Price,
  type Quantity,
} from '@trade-the-pool/shared';
import type { PositionSide } from './domain.js';

export type PositionRisk = {
  side: PositionSide;
  quantity: Quantity;
  averageEntryPrice: Price;
  leverage: number;
  marginUsed: Money;
};

/** Initial margin is rounded up to a cent so risk is never understated. */
export function requiredMargin(notional: Money, leverage: number): Money {
  if (notional <= 0n || !Number.isInteger(leverage) || leverage < 1 || leverage > 5)
    throw new Error('Invalid margin input');
  return moneyFromMinorUnits((notional + BigInt(leverage) - 1n) / BigInt(leverage));
}

export function releasedMargin(
  marginUsed: Money,
  closedQuantity: Quantity,
  positionQuantity: Quantity,
): Money {
  if (
    marginUsed < 0n ||
    closedQuantity <= 0n ||
    positionQuantity <= 0n ||
    closedQuantity > positionQuantity
  )
    throw new Error('Invalid margin release input');
  if (closedQuantity === positionQuantity) return marginUsed;
  return moneyFromMinorUnits(divideRoundHalfUp(marginUsed * closedQuantity, positionQuantity));
}

/**
 * Simplified isolated estimate. Liquidation occurs after a position consumes the portion of
 * initial margin above the configured maintenance requirement.
 */
export function estimatedLiquidationPrice(
  position: PositionRisk,
  maintenanceMarginBasisPoints: bigint,
): Price | null {
  if (position.quantity <= 0n || position.marginUsed <= 0n) return null;
  const maintenance = applyBasisPoints(position.marginUsed, maintenanceMarginBasisPoints);
  const lossCapacity = position.marginUsed - maintenance;
  if (lossCapacity <= 0n) return position.averageEntryPrice;
  const delta = divideRoundHalfUp(
    lossCapacity * DECIMAL_SCALE ** 2n,
    position.quantity * MONEY_SCALE,
  );
  if (position.side === 'LONG')
    return (position.averageEntryPrice > delta ? position.averageEntryPrice - delta : 1n) as Price;
  return (position.averageEntryPrice + delta) as Price;
}

export function shouldLiquidate(
  side: PositionSide,
  mark: Price,
  liquidationPrice: Price | null,
): boolean {
  if (liquidationPrice === null) return false;
  return side === 'LONG' ? mark <= liquidationPrice : mark >= liquidationPrice;
}

export function availableMargin(equity: Money, used: Money, reserved: Money): Money {
  return moneyFromMinorUnits(equity - used - reserved);
}

export function maximumBuyingPower(available: Money, maximumGrossLeverage: number): Money {
  return moneyFromMinorUnits(available > 0n ? available * BigInt(maximumGrossLeverage) : 0n);
}
