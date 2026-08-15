import { describe, expect, it } from 'vitest';
import { parsePrice, parseQuantity, priceToString, quantityToString } from '@trade-the-pool/shared';
import { SubMinuteCandleAggregator, type SubMinuteInterval } from './sub-minute-candles.js';
import type { MarketCandle, MarketTrade } from './types.js';

function trade(timestamp: string, price: string, quantity = '1'): MarketTrade {
  return {
    id: `${timestamp}-${price}`,
    symbol: 'BTC-USD',
    timestamp: new Date(timestamp),
    price: parsePrice(price),
    quantity: parseQuantity(quantity),
    side: 'BUY',
    venue: 'Kraken',
  };
}

function values(candle: MarketCandle | undefined) {
  if (!candle) return null;
  return {
    timestamp: candle.timestamp.toISOString(),
    open: priceToString(candle.open),
    high: priceToString(candle.high),
    low: priceToString(candle.low),
    close: priceToString(candle.close),
    volume: candle.volume === null ? null : quantityToString(candle.volume),
  };
}

describe('SubMinuteCandleAggregator', () => {
  it('creates and incrementally updates an exact UTC one-second candle', () => {
    const events: Array<{ interval: SubMinuteInterval; candle: MarketCandle }> = [];
    const aggregator = new SubMinuteCandleAggregator(['BTC-USD'], (_symbol, interval, candle) =>
      events.push({ interval, candle }),
    );
    aggregator.ingestTrades('BTC-USD', [
      trade('2026-08-14T18:00:01.100Z', '100', '0.25'),
      trade('2026-08-14T18:00:01.300Z', '103', '0.50'),
      trade('2026-08-14T18:00:01.900Z', '99', '0.75'),
    ]);
    expect(values(aggregator.getCandles('BTC-USD', '1s', 1)[0])).toEqual({
      timestamp: '2026-08-14T18:00:01.000Z',
      open: '100.00000000',
      high: '103.00000000',
      low: '99.00000000',
      close: '99.00000000',
      volume: '1.50000000',
    });
    expect(events.filter((event) => event.interval === '1s')).toHaveLength(3);
  });

  it('finalizes on a UTC boundary, fills no-trade seconds flat, and rejects stale trades', () => {
    const aggregator = new SubMinuteCandleAggregator(['BTC-USD'], () => undefined);
    expect(aggregator.ingestTrade('BTC-USD', trade('2026-08-14T18:00:00.900Z', '100'))).toBe(true);
    aggregator.advanceTo(new Date('2026-08-14T18:00:03.100Z'));
    expect(aggregator.getCandles('BTC-USD', '1s', 4).map(values)).toEqual([
      expect.objectContaining({ timestamp: '2026-08-14T18:00:00.000Z', volume: '1.00000000' }),
      expect.objectContaining({
        timestamp: '2026-08-14T18:00:01.000Z',
        close: '100.00000000',
        volume: '0.00000000',
      }),
      expect.objectContaining({
        timestamp: '2026-08-14T18:00:02.000Z',
        close: '100.00000000',
        volume: '0.00000000',
      }),
      expect.objectContaining({
        timestamp: '2026-08-14T18:00:03.000Z',
        close: '100.00000000',
        volume: '0.00000000',
      }),
    ]);
    expect(aggregator.ingestTrade('BTC-USD', trade('2026-08-14T18:00:01.500Z', '200'))).toBe(false);
    expect(
      aggregator.diagnostics('BTC-USD', new Date('2026-08-14T18:00:03.100Z').getTime()),
    ).toMatchObject({
      lastOneSecondCandleFinalized: new Date('2026-08-14T18:00:02.000Z'),
      aggregationLagMs: 100,
    });
  });

  it.each([
    ['5s', 5],
    ['15s', 15],
    ['30s', 30],
  ] as const)(
    'derives an exact UTC-aligned %s candle from canonical 1s children',
    (interval, count) => {
      const aggregator = new SubMinuteCandleAggregator(['BTC-USD'], () => undefined);
      for (let second = 0; second < count; second += 1)
        aggregator.ingestTrade(
          'BTC-USD',
          trade(
            `2026-08-14T18:00:${String(second).padStart(2, '0')}.100Z`,
            String(100 + (second % 3) - (second === count - 1 ? 2 : 0)),
            '0.5',
          ),
        );
      const candle = aggregator.getCandles('BTC-USD', interval, 1)[0];
      expect(candle.timestamp.toISOString()).toBe('2026-08-14T18:00:00.000Z');
      expect(candle.open).toBe(parsePrice('100'));
      expect(candle.high).toBe(parsePrice('102'));
      expect(candle.close).toBe(parsePrice(String(100 + ((count - 1) % 3) - 2)));
      expect(candle.volume).toBe(parseQuantity(String(count / 2)));
    },
  );

  it('does not create bogus candles before the first genuine trade', () => {
    const aggregator = new SubMinuteCandleAggregator(['BTC-USD'], () => undefined);
    aggregator.advanceTo(new Date('2026-08-14T18:00:10Z'));
    expect(aggregator.getCandles('BTC-USD', '1s', 10)).toEqual([]);
  });
});
