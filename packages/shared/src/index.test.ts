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
});
