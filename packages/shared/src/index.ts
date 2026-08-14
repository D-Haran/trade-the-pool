import { z } from 'zod';

export type Money = bigint & { readonly __brand: 'MoneyInCents' };
export type Price = bigint & { readonly __brand: 'PriceAtEightDecimals' };
export type Quantity = bigint & { readonly __brand: 'QuantityAtEightDecimals' };

export const MONEY_SCALE = 100n;
export const DECIMAL_SCALE = 100_000_000n;

const MONEY_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export function parseMoney(value: string): Money {
  if (!MONEY_PATTERN.test(value)) throw new Error('Invalid monetary amount');
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) as Money;
}

export function parseSignedMoney(value: string): Money {
  const sign = value.startsWith('-') ? -1n : 1n;
  const unsigned = sign < 0n ? value.slice(1) : value;
  return moneyFromMinorUnits(sign * parseMoney(unsigned));
}

function parseUnsignedFixed(value: string, decimalPlaces: number, label: string): bigint {
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${decimalPlaces}})?$`);
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimalPlaces) + BigInt(fraction.padEnd(decimalPlaces, '0'));
}

function fixedToString(value: bigint, decimalPlaces: number): string {
  const scale = 10n ** BigInt(decimalPlaces);
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / scale}.${(absolute % scale).toString().padStart(decimalPlaces, '0')}`;
}

export function parsePrice(value: string): Price {
  const price = parseUnsignedFixed(value, 8, 'price');
  if (price <= 0n) throw new Error('Price must be positive');
  return price as Price;
}

export function priceToString(value: Price): string {
  if (value <= 0n) throw new Error('Price must be positive');
  return fixedToString(value, 8);
}

export function decimalToString(value: bigint): string {
  if (value < 0n) throw new Error('Decimal value cannot be negative');
  return fixedToString(value, 8);
}

export function parseQuantity(value: string): Quantity {
  return parseUnsignedFixed(value, 8, 'quantity') as Quantity;
}

export function quantityToString(value: Quantity): string {
  if (value < 0n) throw new Error('Quantity cannot be negative');
  return fixedToString(value, 8);
}

export function moneyToString(value: Money): string {
  if (value < 0n) throw new Error('Money cannot be negative');
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function signedMoneyToString(value: Money): string {
  return fixedToString(value, 2);
}

export function moneyFromMinorUnits(value: bigint): Money {
  return value as Money;
}

export function addMoney(left: Money, right: Money): Money {
  return (left + right) as Money;
}

export function subtractMoney(left: Money, right: Money): Money {
  const result = left - right;
  if (result < 0n) throw new Error('Money result cannot be negative');
  return result as Money;
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Rounds halves away from zero. This is the sole authoritative nearest rounding rule. */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Denominator must be positive');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

/** Converts exact price x quantity to cents, rounding to the nearest cent, halves away from zero. */
export function priceQuantityToMoney(price: Price, quantity: Quantity): Money {
  return moneyFromMinorUnits(
    divideRoundHalfUp(price * quantity * MONEY_SCALE, DECIMAL_SCALE ** 2n),
  );
}

/** Derives an 8-decimal quantity without ever exceeding the supplied notional. */
export function quantityForMoney(notional: Money, price: Price): Quantity {
  if (notional < 0n) throw new Error('Notional cannot be negative');
  return ((notional * DECIMAL_SCALE ** 2n) / (price * MONEY_SCALE)) as Quantity;
}

export function applyBasisPoints(amount: Money, basisPoints: bigint): Money {
  if (basisPoints < 0n) throw new Error('Basis points cannot be negative');
  return moneyFromMinorUnits(divideRoundHalfUp(amount * basisPoints, 10_000n));
}

export function weightedAveragePrice(
  currentPrice: Price,
  currentQuantity: Quantity,
  addedPrice: Price,
  addedQuantity: Quantity,
): Price {
  const total = currentQuantity + addedQuantity;
  if (total <= 0n) throw new Error('Total quantity must be positive');
  return divideRoundHalfUp(
    currentPrice * currentQuantity + addedPrice * addedQuantity,
    total,
  ) as Price;
}

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(values: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(values);
}
