import { describe, expect, it } from 'vitest';
import {
  moneyToString,
  parseMoney,
  parsePrice,
  parseQuantity,
  parseSignedMoney,
  priceToString,
  signedMoneyToString,
} from '@trade-the-pool/shared';
import { DEFAULT_EXECUTION_CONFIG } from './config.js';
import { DomainError } from './errors.js';
import {
  accountEquity,
  assertFreshSnapshot,
  assertExecutionEligibleSnapshot,
  assertTradable,
  buyPosition,
  calculateFee,
  calculateFillQuote,
  decreasePosition,
  grossExposure,
  increasePosition,
  sellPosition,
  unrealizedPnL,
} from './domain.js';

describe('deterministic execution model', () => {
  it('adds spread and notional-sensitive bounded slippage to buys', () => {
    const small = calculateFillQuote(
      parsePrice('100000.00'),
      'BUY',
      parseMoney('5000.00'),
      'BTC-USD',
      DEFAULT_EXECUTION_CONFIG,
    );
    const large = calculateFillQuote(
      parsePrice('100000.00'),
      'BUY',
      parseMoney('100000.00'),
      'BTC-USD',
      DEFAULT_EXECUTION_CONFIG,
    );
    expect(priceToString(small.spreadAmount)).toBe('50.00000000');
    expect(priceToString(small.slippageAmount)).toBe('1.00000000');
    expect(priceToString(small.fillPrice)).toBe('100051.00000000');
    expect(large.fillPrice).toBeGreaterThan(small.fillPrice);
  });

  it('subtracts adjustments from sells and caps slippage at its configured maximum', () => {
    const quote = calculateFillQuote(
      parsePrice('200.00'),
      'SELL',
      parseMoney('999999.00'),
      'SOL-USD',
      DEFAULT_EXECUTION_CONFIG,
    );
    expect(priceToString(quote.spreadAmount)).toBe('0.10000000');
    expect(priceToString(quote.slippageAmount)).toBe('0.40000000');
    expect(priceToString(quote.fillPrice)).toBe('199.50000000');
  });

  it('rounds fees to cents', () => {
    expect(moneyToString(calculateFee(parseMoney('5000.00'), DEFAULT_EXECUTION_CONFIG))).toBe(
      '5.00',
    );
  });
});

describe('average-cost position accounting', () => {
  it('maintains average cost across buys and realizes a partial sale', () => {
    let position = buyPosition(null, 'SOL-USD', parseQuantity('1'), parsePrice('100'));
    position = buyPosition(position, 'SOL-USD', parseQuantity('1'), parsePrice('120'));
    expect(priceToString(position.averageEntryPrice)).toBe('110.00000000');
    const sold = sellPosition(position, parseQuantity('1'), parsePrice('130'));
    expect(moneyToString(sold.realizedOnFill)).toBe('20.00');
    expect(sold.position.quantity).toBe(parseQuantity('1'));
    expect(priceToString(sold.position.averageEntryPrice)).toBe('110.00000000');
  });

  it('supports losses and a full close without a negative quantity', () => {
    const position = buyPosition(null, 'SOL-USD', parseQuantity('2'), parsePrice('100'));
    expect(signedMoneyToString(unrealizedPnL(position, parsePrice('90')))).toBe('-20.00');
  });

  it('calculates signed unrealized P&L and equity from cash plus marked holdings', () => {
    const position = buyPosition(null, 'SOL-USD', parseQuantity('2'), parsePrice('100'));
    expect(unrealizedPnL(position, parsePrice('90'))).toBe(-2000n);
    expect(
      moneyToString(
        accountEquity(parseMoney('800.00'), [position], new Map([['SOL-USD', parsePrice('90')]])),
      ),
    ).toBe('980.00');
    const closed = sellPosition(position, parseQuantity('2'), parsePrice('90'));
    expect(closed.position.quantity).toBe(0n);
    expect(closed.realizedOnFill).toBe(-2000n);
  });

  it('rejects oversells', () => {
    const position = buyPosition(null, 'BTC-USD', parseQuantity('0.1'), parsePrice('100000'));
    expect(() => sellPosition(position, parseQuantity('0.2'), parsePrice('110000'))).toThrow(
      'exceeds',
    );
  });

  it('marks and realizes short positions without binary floating-point arithmetic', () => {
    const short = increasePosition(
      null,
      'ETH-USD',
      'SHORT',
      parseQuantity('0.25'),
      parsePrice('4000'),
    );
    expect(signedMoneyToString(unrealizedPnL(short, parsePrice('3800')))).toBe('50.00');
    expect(moneyToString(grossExposure([short], new Map([['ETH-USD', parsePrice('3800')]])))).toBe(
      '950.00',
    );
    expect(
      moneyToString(
        accountEquity(parseMoney('11000.00'), [short], new Map([['ETH-USD', parsePrice('3800')]])),
      ),
    ).toBe('10050.00');
    const closed = decreasePosition(short, 'SHORT', parseQuantity('0.10'), parsePrice('3800'));
    expect(moneyToString(closed.realizedOnFill)).toBe('20.00');
    expect(closed.position.quantity).toBe(parseQuantity('0.15'));
  });

  it.each([
    ['LONG', '100', '110', '2.50'],
    ['LONG', '100', '90', '-2.50'],
    ['SHORT', '100', '90', '2.50'],
    ['SHORT', '100', '110', '-2.50'],
  ] as const)('uses the authoritative %s realized P&L formula', (side, entry, exit, expected) => {
    const opened = increasePosition(null, 'ETH-USD', side, parseQuantity('1'), parsePrice(entry));
    const partial = decreasePosition(opened, side, parseQuantity('0.25'), parsePrice(exit));
    expect(signedMoneyToString(partial.realizedOnFill)).toBe(
      signedMoneyToString(parseSignedMoney(expected)),
    );
    expect(partial.position.quantity).toBe(parseQuantity('0.75'));
    const closed = decreasePosition(
      partial.position,
      side,
      parseQuantity('0.75'),
      parsePrice(exit),
    );
    expect(closed.position.quantity).toBe(0n);
    expect(closed.position.averageEntryPrice).toBe(0n);
  });
});

describe('server-authoritative tradability', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const schedule = {
    registrationOpensAt: new Date(now.getTime() - 2_000),
    tradingStartsAt: new Date(now.getTime() - 1_000),
    entryClosesAt: new Date(now.getTime() + 1_000),
    tradingClosesAt: new Date(now.getTime() + 2_000),
  };

  it('allows trading from the configured start through the entry-closed phase', () => {
    expect(() => assertTradable('TRADING_ACTIVE', schedule, now)).not.toThrow();
    expect(() =>
      assertTradable('ENTRY_CLOSED', schedule, new Date(now.getTime() + 1_500)),
    ).not.toThrow();
  });

  it('rejects pre-start and close-boundary orders plus stale/future prices', () => {
    expect(() =>
      assertTradable('REGISTRATION_OPEN', schedule, new Date(now.getTime() - 1_500)),
    ).toThrow();
    expect(() => assertTradable('TRADING_ACTIVE', schedule, schedule.tradingClosesAt)).toThrow();
    expect(() => assertFreshSnapshot(new Date(now.getTime() - 30_001), now, 30_000)).toThrow();
    expect(() => assertFreshSnapshot(new Date(now.getTime() + 1), now, 30_000)).toThrow();
    expect(() => assertFreshSnapshot(new Date('invalid'), now, 30_000)).toThrow();
  });

  it('fails closed when the central market service marks authority degraded', () => {
    const snapshot = {
      symbol: 'BTC-USD' as const,
      price: parsePrice('100000'),
      marketTimestamp: new Date(),
      receivedAt: new Date(),
      source: 'authoritative-mark',
      status: 'DEGRADED' as const,
      executionEligible: false,
    };
    expect(() => assertExecutionEligibleSnapshot(snapshot)).toThrow(DomainError);
    expect(() =>
      assertExecutionEligibleSnapshot({ ...snapshot, status: 'LIVE', executionEligible: true }),
    ).not.toThrow();
  });
});
