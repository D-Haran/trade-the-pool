import { describe, expect, it } from 'vitest';
import { priceToString, quantityToString } from '@trade-the-pool/shared';
import { KrakenOrderBook, krakenBookChecksum, type RawBookLevel } from './order-book.js';

const bids: RawBookLevel[] = [
  { price: '45283.5', qty: '0.10000000' },
  { price: '45283.4', qty: '1.54582015' },
  { price: '45282.1', qty: '0.10000000' },
  { price: '45281.0', qty: '0.10000000' },
  { price: '45280.3', qty: '1.54592586' },
  { price: '45279.0', qty: '0.07990000' },
  { price: '45277.6', qty: '0.03310103' },
  { price: '45277.5', qty: '0.30000000' },
  { price: '45277.3', qty: '1.54602737' },
  { price: '45276.6', qty: '0.15445238' },
];
const asks: RawBookLevel[] = [
  { price: '45285.2', qty: '0.00100000' },
  { price: '45286.4', qty: '1.54571953' },
  { price: '45286.6', qty: '1.54571109' },
  { price: '45289.6', qty: '1.54560911' },
  { price: '45290.2', qty: '0.15890660' },
  { price: '45291.8', qty: '1.54553491' },
  { price: '45294.7', qty: '0.04454749' },
  { price: '45296.1', qty: '0.35380000' },
  { price: '45297.5', qty: '0.09945542' },
  { price: '45299.5', qty: '0.18772827' },
];

describe('KrakenOrderBook', () => {
  it('matches Kraken CRC32 guidance and builds a sorted cumulative snapshot', () => {
    expect(krakenBookChecksum(asks, bids)).toBe(3310070434);
    const book = new KrakenOrderBook('BTC-USD', 10);
    expect(
      book.applySnapshot({
        symbol: 'BTC-USD',
        bids,
        asks,
        checksum: 3310070434,
        timestamp: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBe(true);
    const snapshot = book.snapshot();
    expect(priceToString(snapshot.bids[0].price)).toBe('45283.50000000');
    expect(priceToString(snapshot.asks[0].price)).toBe('45285.20000000');
    expect(quantityToString(snapshot.bids[1].total)).toBe('1.64582015');
    expect(snapshot.status).toBe('LIVE');
  });

  it('applies deltas, removes zero quantity, truncates depth, and resynchronizes on corruption', () => {
    const book = new KrakenOrderBook('BTC-USD', 10);
    book.applySnapshot({
      symbol: 'BTC-USD',
      bids,
      asks,
      checksum: krakenBookChecksum(asks, bids),
      timestamp: new Date(),
    });
    const nextBids = bids.filter((level) => level.price !== '45283.5');
    const nextAsks = asks.map((level) =>
      level.price === '45285.2' ? { ...level, qty: '0.00200000' } : level,
    );
    expect(
      book.applyUpdate({
        symbol: 'BTC-USD',
        bids: [{ price: '45283.5', qty: '0' }],
        asks: [{ price: '45285.2', qty: '0.00200000' }],
        checksum: krakenBookChecksum(nextAsks, nextBids),
        timestamp: new Date(),
      }),
    ).toBe(true);
    expect(priceToString(book.snapshot().bids[0].price)).toBe('45283.40000000');
    expect(
      book.applyUpdate({
        symbol: 'BTC-USD',
        bids: [],
        asks: [],
        checksum: 1,
        timestamp: new Date(),
      }),
    ).toBe(false);
    expect(book.snapshot()).toMatchObject({ status: 'RECONNECTING', bids: [], asks: [] });
  });
});
