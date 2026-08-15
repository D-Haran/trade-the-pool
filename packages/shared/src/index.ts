import { z } from 'zod';

export * from './api.js';
export * from './markets.js';

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

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalFeedId = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .string()
    .regex(/^(?:0x)?[0-9a-fA-F]{64}$/)
    .optional(),
);

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    DEV_AUTH_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    API_DOCS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
    WALLET_AUTH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    SOLANA_CLUSTER: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']).default('devnet'),
    WALLET_AUTH_ORIGIN: z.string().url().default('http://localhost:3000'),
    WALLET_AUTH_DOMAIN: z.string().min(1).max(255).default('localhost:3000'),
    WALLET_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
    MARKET_DATA_MODE: z.enum(['fake', 'live']).default('fake'),
    KRAKEN_WS_URL: z.string().url().default('wss://ws.kraken.com/v2'),
    KRAKEN_REST_URL: z.string().url().default('https://api.kraken.com'),
    COINBASE_WS_URL: z.string().url().default('wss://advanced-trade-ws.coinbase.com'),
    PYTH_HERMES_URL: z.string().url().default('https://pyth.dourolabs.app/hermes'),
    PYTH_API_KEY: optionalNonEmptyString,
    PYTH_FEED_ID_BTC_USD: optionalFeedId,
    PYTH_FEED_ID_ETH_USD: optionalFeedId,
    PYTH_FEED_ID_SOL_USD: optionalFeedId,
    PYTH_FEED_ID_XRP_USD: optionalFeedId,
    PYTH_FEED_ID_DOGE_USD: optionalFeedId,
    PYTH_FEED_ID_LINK_USD: optionalFeedId,
    PYTH_FEED_ID_AVAX_USD: optionalFeedId,
    PYTH_FEED_ID_ADA_USD: optionalFeedId,
    PYTH_FEED_ID_SUI_USD: optionalFeedId,
    PYTH_FEED_ID_AAVE_USD: optionalFeedId,
    PYTH_FEED_ID_NEAR_USD: optionalFeedId,
    PYTH_FEED_ID_LTC_USD: optionalFeedId,
    MARKET_AUTHORITATIVE_DELAYED_MS: z.coerce.number().int().min(1_000).default(5_000),
    MARKET_AUTHORITATIVE_STALE_MS: z.coerce.number().int().min(2_000).default(20_000),
    MARKET_EXCHANGE_DELAYED_MS: z.coerce.number().int().min(1_000).default(5_000),
    MARKET_EXCHANGE_STALE_MS: z.coerce.number().int().min(2_000).default(30_000),
    MARKET_BOOK_STALE_MS: z.coerce.number().int().min(2_000).default(15_000),
    MARKET_COMPARISON_STALE_MS: z.coerce.number().int().min(2_000).default(30_000),
    MARKET_MAX_DEVIATION_BPS: z.coerce.number().int().min(1).max(5_000).default(100),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.DEV_AUTH_ENABLED)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEV_AUTH_ENABLED'],
        message: 'Development authentication cannot be enabled in production',
      });
    if (environment.NODE_ENV === 'production' && environment.MARKET_DATA_MODE !== 'live')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MARKET_DATA_MODE'],
        message: 'Production requires MARKET_DATA_MODE=live',
      });
    const origins = environment.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
    if (!origins.length || origins.some((origin) => !origin || origin === '*'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'Credentialed CORS requires one or more explicit origins',
      });
    for (const origin of origins) {
      try {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol))
          throw new Error('not an origin');
        if (environment.NODE_ENV === 'production' && parsed.protocol !== 'https:')
          throw new Error('production origin is not HTTPS');
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `Invalid${environment.NODE_ENV === 'production' ? ' production HTTPS' : ''} origin: ${origin}`,
        });
      }
    }
    try {
      const walletOrigin = new URL(environment.WALLET_AUTH_ORIGIN);
      if (
        walletOrigin.origin !== environment.WALLET_AUTH_ORIGIN ||
        walletOrigin.host !== environment.WALLET_AUTH_DOMAIN ||
        !['http:', 'https:'].includes(walletOrigin.protocol)
      )
        throw new Error('wallet origin/domain mismatch');
      if (environment.NODE_ENV === 'production' && walletOrigin.protocol !== 'https:')
        throw new Error('production wallet origin is not HTTPS');
      if (environment.WALLET_AUTH_ENABLED && !origins.includes(walletOrigin.origin))
        throw new Error('wallet origin is not CORS allowlisted');
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WALLET_AUTH_ORIGIN'],
        message:
          'Wallet auth origin must be an allowed exact origin whose host matches WALLET_AUTH_DOMAIN',
      });
    }
    if (environment.MARKET_DATA_MODE === 'live') {
      for (const key of [
        'PYTH_API_KEY',
        'PYTH_FEED_ID_BTC_USD',
        'PYTH_FEED_ID_ETH_USD',
        'PYTH_FEED_ID_SOL_USD',
        'PYTH_FEED_ID_XRP_USD',
        'PYTH_FEED_ID_DOGE_USD',
        'PYTH_FEED_ID_LINK_USD',
        'PYTH_FEED_ID_AVAX_USD',
        'PYTH_FEED_ID_ADA_USD',
        'PYTH_FEED_ID_SUI_USD',
        'PYTH_FEED_ID_AAVE_USD',
        'PYTH_FEED_ID_NEAR_USD',
        'PYTH_FEED_ID_LTC_USD',
      ] as const)
        if (!environment[key])
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when MARKET_DATA_MODE=live`,
          });
    }
    if (environment.MARKET_AUTHORITATIVE_DELAYED_MS >= environment.MARKET_AUTHORITATIVE_STALE_MS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MARKET_AUTHORITATIVE_STALE_MS'],
        message: 'Authoritative stale threshold must exceed the delayed threshold',
      });
    if (environment.MARKET_EXCHANGE_DELAYED_MS >= environment.MARKET_EXCHANGE_STALE_MS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MARKET_EXCHANGE_STALE_MS'],
        message: 'Exchange stale threshold must exceed the delayed threshold',
      });
  });

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(values: NodeJS.ProcessEnv): Environment {
  return environmentSchema.parse(values);
}
