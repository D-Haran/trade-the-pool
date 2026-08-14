import { describe, expect, it } from 'vitest';
import { priceToString } from '@trade-the-pool/shared';
import { DeterministicMarketPriceSource } from './index.js';

describe('DeterministicMarketPriceSource', () => {
  it('provides exact deterministic initial prices and authoritative snapshots', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const source = new DeterministicMarketPriceSource(timestamp);
    expect(priceToString(source.getPrice('BTC-USD'))).toBe('100000.00000000');
    expect(source.getSnapshot('ETH-USD')).toMatchObject({
      symbol: 'ETH-USD',
      marketTimestamp: timestamp,
      source: 'deterministic-memory-v1',
    });
  });

  it('allows exact manual price advancement and rejects time reversal', () => {
    const source = new DeterministicMarketPriceSource(new Date('2026-01-01T00:00:00.000Z'));
    const next = new Date('2026-01-01T00:00:01.000Z');
    source.advancePrice('SOL-USD', '201.12345678', next);
    expect(priceToString(source.getPrice('SOL-USD'))).toBe('201.12345678');
    expect(() => source.advancePrice('SOL-USD', '202.00', new Date(0))).toThrow(
      'cannot move backwards',
    );
  });

  it('notifies subscribers with an authoritative snapshot and supports unsubscribe', () => {
    const source = new DeterministicMarketPriceSource(new Date('2026-01-01T00:00:00.000Z'));
    const received: string[] = [];
    const unsubscribe = source.subscribe((snapshot) =>
      received.push(priceToString(snapshot.price)),
    );
    source.advancePrice('SOL-USD', '201.00', new Date('2026-01-01T00:00:01.000Z'));
    unsubscribe();
    source.advancePrice('SOL-USD', '202.00', new Date('2026-01-01T00:00:02.000Z'));
    expect(received).toEqual(['201.00000000']);
  });

  it('serves deterministic shared candle history and aggregates intervals', () => {
    const source = new DeterministicMarketPriceSource(new Date('2026-01-01T12:00:00.000Z'));
    const minutes = source.getCandles('BTC-USD', '1m', 10);
    const fiveMinutes = source.getCandles('BTC-USD', '5m', 10);

    expect(minutes).toHaveLength(10);
    expect(fiveMinutes.length).toBeGreaterThan(1);
    expect(fiveMinutes.length).toBeLessThanOrEqual(10);
    expect(minutes.at(-1)?.close).toBe(source.getSnapshot('BTC-USD').price);
    expect(minutes.every((candle) => candle.high >= candle.low)).toBe(true);
  });
});
