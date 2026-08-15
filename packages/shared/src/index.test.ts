import { describe, expect, it } from 'vitest';
import {
  addMoney,
  applyBasisPoints,
  divideRoundHalfUp,
  moneyToString,
  parseMoney,
  parsePrice,
  parseQuantity,
  priceQuantityToMoney,
  priceToString,
  quantityForMoney,
  quantityToString,
  signedMoneyToString,
  subtractMoney,
  weightedAveragePrice,
  parseEnvironment,
  MARKET_REGISTRY,
  SUPPORTED_MARKET_SYMBOLS,
  allowedLeverages,
  CANDLE_INTERVALS,
  candleIntervalSchema,
  realtimeSubscriptionSchema,
  professionalOrderRequestSchema,
} from './index.js';

describe('money', () => {
  it('uses exact cents without binary floating point', () => {
    const amount = parseMoney('50000.00');
    expect(moneyToString(addMoney(amount, parseMoney('25.00')))).toBe('50025.00');
    expect(moneyToString(subtractMoney(amount, parseMoney('0.01')))).toBe('49999.99');
  });
  it('rejects more than two decimal places', () => expect(() => parseMoney('1.001')).toThrow());

  it('supports signed display without allowing negative cash parsing', () => {
    expect(signedMoneyToString(-123n as ReturnType<typeof parseMoney>)).toBe('-1.23');
    expect(() => parseMoney('-1.00')).toThrow();
  });
});

describe('exact price and quantity arithmetic', () => {
  it('parses and serializes eight decimal places exactly', () => {
    expect(priceToString(parsePrice('100000.12345678'))).toBe('100000.12345678');
    expect(quantityToString(parseQuantity('0.12345678'))).toBe('0.12345678');
    expect(() => parseQuantity('0.123456789')).toThrow();
  });

  it('uses floor when deriving quantity and half-up when settling cents', () => {
    const price = parsePrice('3.00000000');
    const quantity = quantityForMoney(parseMoney('1.00'), price);
    expect(quantityToString(quantity)).toBe('0.33333333');
    expect(moneyToString(priceQuantityToMoney(price, quantity))).toBe('1.00');
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n);
  });

  it('centralizes fee and weighted-average rounding', () => {
    expect(moneyToString(applyBasisPoints(parseMoney('10.00'), 5n))).toBe('0.01');
    expect(
      priceToString(
        weightedAveragePrice(
          parsePrice('100.00'),
          parseQuantity('1.00'),
          parsePrice('120.00'),
          parseQuantity('1.00'),
        ),
      ),
    ).toBe('110.00000000');
  });
});

describe('environment security', () => {
  const required = {
    DATABASE_URL: 'postgresql://localhost/database',
    REDIS_URL: 'redis://localhost:6379',
  };
  const liveMarketData = {
    MARKET_DATA_MODE: 'live',
    PYTH_API_KEY: 'test-key',
    PYTH_FEED_ID_BTC_USD: 'aa'.repeat(32),
    PYTH_FEED_ID_ETH_USD: 'bb'.repeat(32),
    PYTH_FEED_ID_SOL_USD: 'cc'.repeat(32),
    PYTH_FEED_ID_XRP_USD: 'dd'.repeat(32),
    PYTH_FEED_ID_DOGE_USD: 'ee'.repeat(32),
    PYTH_FEED_ID_LINK_USD: 'ff'.repeat(32),
    PYTH_FEED_ID_AVAX_USD: '11'.repeat(32),
    PYTH_FEED_ID_ADA_USD: '22'.repeat(32),
    PYTH_FEED_ID_SUI_USD: '33'.repeat(32),
    PYTH_FEED_ID_AAVE_USD: '44'.repeat(32),
    PYTH_FEED_ID_NEAR_USD: '55'.repeat(32),
    PYTH_FEED_ID_LTC_USD: '66'.repeat(32),
  };

  it('rejects development authentication in production', () => {
    expect(() =>
      parseEnvironment({ ...required, NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true' }),
    ).toThrow('Development authentication cannot be enabled in production');
  });

  it('parses explicit boolean feature flags without truthy string coercion', () => {
    expect(parseEnvironment({ ...required, DEV_AUTH_ENABLED: 'false' }).DEV_AUTH_ENABLED).toBe(
      false,
    );
  });

  it('defaults to a fixed seven-day session and does not trust proxies', () => {
    const environment = parseEnvironment(required);
    expect(environment.SESSION_TTL_SECONDS).toBe(604_800);
    expect(environment.TRUST_PROXY).toBe(false);
    expect(environment.SOLANA_CLUSTER).toBe('devnet');
    expect(environment.WALLET_CHALLENGE_TTL_SECONDS).toBe(300);
  });

  it('binds wallet authentication to one exact allowlisted origin and domain', () => {
    expect(() =>
      parseEnvironment({
        ...required,
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
        WALLET_AUTH_ORIGIN: 'https://app.example.com',
        WALLET_AUTH_DOMAIN: 'other.example.com',
      }),
    ).toThrow('Wallet auth origin must be an allowed exact origin');
    expect(
      parseEnvironment({
        ...required,
        ...liveMarketData,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.example.com',
        WALLET_AUTH_ORIGIN: 'https://app.example.com',
        WALLET_AUTH_DOMAIN: 'app.example.com',
      }).WALLET_AUTH_DOMAIN,
    ).toBe('app.example.com');
  });

  it('rejects wildcard credentialed CORS and non-HTTPS production origins', () => {
    expect(() => parseEnvironment({ ...required, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      'Credentialed CORS requires one or more explicit origins',
    );
    expect(() =>
      parseEnvironment({
        ...required,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'http://app.example.com',
      }),
    ).toThrow('Invalid production HTTPS origin');
  });

  it('treats blank optional live credentials as unset in fake mode', () => {
    const environment = parseEnvironment({
      ...required,
      MARKET_DATA_MODE: 'fake',
      PYTH_API_KEY: '',
      PYTH_FEED_ID_BTC_USD: '',
      PYTH_FEED_ID_ETH_USD: '',
      PYTH_FEED_ID_SOL_USD: '',
    });
    expect(environment.PYTH_API_KEY).toBeUndefined();
    expect(environment.PYTH_FEED_ID_BTC_USD).toBeUndefined();
  });

  it('requires all Pyth credentials in live mode', () => {
    expect(() =>
      parseEnvironment({ ...required, MARKET_DATA_MODE: 'live', PYTH_API_KEY: '' }),
    ).toThrow('PYTH_API_KEY is required when MARKET_DATA_MODE=live');
  });

  it('rejects fake market data in production', () => {
    expect(() =>
      parseEnvironment({ ...required, NODE_ENV: 'production', MARKET_DATA_MODE: 'fake' }),
    ).toThrow('Production requires MARKET_DATA_MODE=live');
  });
});

describe('canonical market registry', () => {
  it('keeps a curated, ordered universe with bounded asset-specific leverage', () => {
    expect(SUPPORTED_MARKET_SYMBOLS).toHaveLength(12);
    expect(MARKET_REGISTRY['BTC-USD'].maxLeverage).toBe(5);
    expect(MARKET_REGISTRY['SUI-USD'].maxLeverage).toBe(2);
    expect(allowedLeverages('SOL-USD')).toEqual([1, 2, 3, 4]);
    expect(SUPPORTED_MARKET_SYMBOLS).not.toContain('PEPE-USD');
  });
});

describe('canonical candle intervals', () => {
  it('shares every supported interval across validation and scoped realtime topics', () => {
    expect(CANDLE_INTERVALS).toEqual([
      '1s',
      '5s',
      '15s',
      '30s',
      '1m',
      '5m',
      '15m',
      '1h',
      '4h',
      '1d',
    ]);
    for (const interval of CANDLE_INTERVALS) {
      expect(candleIntervalSchema.parse(interval)).toBe(interval);
      expect(
        realtimeSubscriptionSchema.parse({
          action: 'subscribe',
          topic: `market:BTC-USD:candles:${interval}`,
        }).topic,
      ).toBe(`market:BTC-USD:candles:${interval}`);
    }
  });
});

describe('professional order sizing', () => {
  it.each(['MARGIN', 'POSITION_SIZE'] as const)('accepts explicit %s sizing', (type) => {
    expect(
      professionalOrderRequestSchema.parse({
        entryId: '00000000-0000-4000-8000-000000000001',
        symbol: 'BTC-USD',
        intent: 'OPEN',
        positionSide: 'LONG',
        sizing: { type, amount: '1000.00' },
        leverage: 5,
        execution: { type: 'MARKET' },
      }),
    ).toMatchObject({ sizing: { type, amount: '1000.00' } });
  });

  it('rejects the former ambiguous notional-only professional request', () => {
    expect(() =>
      professionalOrderRequestSchema.parse({
        entryId: '00000000-0000-4000-8000-000000000001',
        symbol: 'BTC-USD',
        intent: 'OPEN',
        positionSide: 'LONG',
        notional: '1000.00',
        leverage: 5,
        execution: { type: 'MARKET' },
      }),
    ).toThrow();
  });
});
