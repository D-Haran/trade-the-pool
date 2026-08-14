import { describe, expect, it } from 'vitest';
import { priceToString } from '@trade-the-pool/shared';
import {
  boundedBackoffMs,
  KrakenMarketDataAdapter,
  parseJsonPreservingDecimals,
  parsePythUpdates,
  pythIntegerToPrice,
} from './providers.js';
import { krakenBookChecksum } from './order-book.js';
import type { UpstreamEvent } from './providers.js';
import { canonicalSymbol } from './types.js';

describe('provider normalization', () => {
  it('preserves upstream decimal lexemes and rejects malformed JSON', () => {
    expect(parseJsonPreservingDecimals('{"price":45285.2000,"count":2}')).toEqual({
      price: '45285.2000',
      count: 2,
    });
    expect(() => parseJsonPreservingDecimals('{broken')).toThrow();
  });

  it('normalizes Pyth integer/exponent prices and configured feed IDs', () => {
    expect(priceToString(pythIntegerToPrice('10012345678900', -8))).toBe('100123.45678900');
    const snapshots = parsePythUpdates(
      {
        parsed: [
          {
            id: 'aa'.repeat(32),
            price: {
              price: '10000000000000',
              conf: '25000000',
              expo: -8,
              publish_time: 1_800_000_000,
            },
          },
        ],
      },
      { 'BTC-USD': `0x${'aa'.repeat(32)}`, 'ETH-USD': 'bb'.repeat(32), 'SOL-USD': 'cc'.repeat(32) },
      new Date('2027-01-15T08:00:01Z'),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ symbol: 'BTC-USD', source: 'pyth-hermes' });
    expect(priceToString(snapshots[0].price)).toBe('100000.00000000');
    expect(
      parsePythUpdates(
        {
          parsed: [
            {
              id: 'aa'.repeat(32),
              price: { price: 'not-a-price', conf: 'x', expo: -8, publish_time: 'invalid' },
            },
          ],
        },
        {
          'BTC-USD': 'aa'.repeat(32),
          'ETH-USD': 'bb'.repeat(32),
          'SOL-USD': 'cc'.repeat(32),
        },
      ),
    ).toEqual([]);
  });

  it('keeps provider symbol formats inside canonical adapter mappings', () => {
    expect(canonicalSymbol('kraken', 'BTC/USD')).toBe('BTC-USD');
    expect(canonicalSymbol('coinbase', 'ETH-USD')).toBe('ETH-USD');
    expect(canonicalSymbol('kraken', 'DOGE/USD')).toBeNull();
  });

  it('uses bounded exponential reconnect backoff with jitter', () => {
    expect(boundedBackoffMs(0, () => 0)).toBe(500);
    expect(boundedBackoffMs(20, () => 0)).toBe(30_000);
    expect(boundedBackoffMs(20, () => 0.999)).toBeLessThanOrEqual(32_000);
  });

  it('normalizes recorded Kraken ticker, trade, candle, and L2 snapshot messages', () => {
    const adapter = new KrakenMarketDataAdapter({
      wsUrl: 'wss://example.invalid',
      restUrl: 'https://example.invalid',
      depth: 10,
    });
    const events: UpstreamEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const feed = (raw: string) =>
      (adapter as unknown as { onMessage(raw: string): void }).onMessage(raw);
    feed(
      '{"channel":"ticker","type":"update","data":[{"symbol":"ETH/USD","last":4001.25,"change_pct":1.25,"high":4100.5,"low":3900.25,"volume":12345.6789,"timestamp":"2026-08-14T18:00:00.123456Z"}]}',
    );
    feed(
      '{"channel":"trade","type":"update","data":[{"symbol":"ETH/USD","side":"buy","qty":0.125,"price":4001.5,"trade_id":987654,"timestamp":"2026-08-14T18:00:01.123456Z"}]}',
    );
    feed(
      '{"channel":"ohlc","type":"update","data":[{"symbol":"ETH/USD","interval":5,"interval_begin":"2026-08-14T18:00:00Z","open":4000,"high":4002,"low":3999.5,"close":4001.5,"volume":15.25}]}',
    );
    const bids = [{ price: '4001.0', qty: '1.25' }];
    const asks = [{ price: '4002.0', qty: '2.5' }];
    feed(
      JSON.stringify({
        channel: 'book',
        type: 'snapshot',
        data: [
          {
            symbol: 'ETH/USD',
            bids,
            asks,
            checksum: krakenBookChecksum(asks, bids),
            timestamp: '2026-08-14T18:00:02.123456Z',
          },
        ],
      }),
    );

    expect(events.find((event) => event.type === 'price')).toMatchObject({
      type: 'price',
      role: 'PRIMARY_EXCHANGE',
      snapshot: { symbol: 'ETH-USD', source: 'kraken-ws-v2' },
      statistics: { change24hBasisPoints: 125n },
    });
    expect(events.find((event) => event.type === 'trades')).toMatchObject({
      type: 'trades',
      symbol: 'ETH-USD',
      trades: [{ id: '987654', side: 'BUY', venue: 'Kraken' }],
    });
    expect(events.find((event) => event.type === 'candle')).toMatchObject({
      type: 'candle',
      symbol: 'ETH-USD',
      interval: '5m',
    });
    expect(events.find((event) => event.type === 'book')).toMatchObject({
      type: 'book',
      book: { symbol: 'ETH-USD', venue: 'Kraken', status: 'LIVE' },
    });
  });

  it('subscribes to one Kraken OHLC interval per symbol set', () => {
    const adapter = new KrakenMarketDataAdapter({
      wsUrl: 'wss://example.invalid',
      restUrl: 'https://example.invalid',
      depth: 10,
    });
    const sent: string[] = [];
    (adapter as unknown as { onOpen(socket: { send(value: string): void }): void }).onOpen({
      send: (value) => sent.push(value),
    });
    const subscriptions = sent.map((value) => JSON.parse(value));
    expect(subscriptions.filter((item) => item.params.channel === 'ohlc')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ interval: 1 }) }),
    ]);
  });
});
