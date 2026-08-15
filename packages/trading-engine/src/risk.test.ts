import { describe, expect, it } from 'vitest';
import {
  moneyToString,
  parseMoney,
  parsePrice,
  parseQuantity,
  priceToString,
} from '@trade-the-pool/shared';
import {
  estimatedLiquidationPrice,
  positionNotionalFromMargin,
  releasedMargin,
  requiredMargin,
  shouldLiquidate,
} from './risk.js';

describe('fixed-precision leverage and margin', () => {
  it.each([
    [1, '10000.00'],
    [2, '5000.00'],
    [3, '3333.34'],
    [5, '2000.00'],
  ])('reserves exact initial margin at %ix', (leverage, expected) => {
    expect(moneyToString(requiredMargin(parseMoney('10000.00'), leverage))).toBe(expected);
  });

  it('turns margin sizing into the same authoritative notional for long and short orders', () => {
    const notional = positionNotionalFromMargin(parseMoney('1000.00'), 5);
    expect(moneyToString(notional)).toBe('5000.00');
    expect(moneyToString(requiredMargin(notional, 5))).toBe('1000.00');
  });

  it('releases partial margin proportionally and closes without residual cents', () => {
    expect(
      moneyToString(
        releasedMargin(parseMoney('3333.34'), parseQuantity('0.25000000'), parseQuantity('1.00')),
      ),
    ).toBe('833.34');
    expect(
      moneyToString(
        releasedMargin(parseMoney('3333.34'), parseQuantity('1.00'), parseQuantity('1.00')),
      ),
    ).toBe('3333.34');
  });

  it('computes symmetric isolated liquidation estimates', () => {
    const common = {
      quantity: parseQuantity('1.00'),
      averageEntryPrice: parsePrice('100.00'),
      leverage: 5,
      marginUsed: parseMoney('20.00'),
    };
    const long = estimatedLiquidationPrice({ ...common, side: 'LONG' }, 2_000n);
    const short = estimatedLiquidationPrice({ ...common, side: 'SHORT' }, 2_000n);
    expect(priceToString(long!)).toBe('84.00000000');
    expect(priceToString(short!)).toBe('116.00000000');
    expect(shouldLiquidate('LONG', parsePrice('84.00'), long)).toBe(true);
    expect(shouldLiquidate('SHORT', parsePrice('115.99'), short)).toBe(false);
  });
});
