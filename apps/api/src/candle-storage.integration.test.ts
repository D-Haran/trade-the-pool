import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { createDatabase, subMinuteCandles } from '@trade-the-pool/database';
import { parsePrice, parseQuantity, priceToString } from '@trade-the-pool/shared';
import { PostgresSubMinuteCandleStore } from './candle-storage.js';

const connection = createDatabase(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const store = new PostgresSubMinuteCandleStore(connection.db);
const start = new Date('2040-01-01T00:00:00Z');

afterAll(async () => {
  await connection.db
    .delete(subMinuteCandles)
    .where(
      and(
        eq(subMinuteCandles.symbol, 'BTC-USD'),
        eq(subMinuteCandles.interval, '5s'),
        gte(subMinuteCandles.timestamp, start),
      ),
    );
  await connection.client.end();
});

describe('PostgresSubMinuteCandleStore', () => {
  it('persists, upserts, and paginates completed bars without duplicates', async () => {
    for (let index = 0; index < 3; index += 1) {
      const price = parsePrice(String(100 + index));
      await store.persist(
        {
          symbol: 'BTC-USD',
          interval: '5s',
          source: 'test',
          candle: {
            timestamp: new Date(start.getTime() + index * 5_000),
            open: price,
            high: price,
            low: price,
            close: price,
            volume: parseQuantity('1'),
          },
        },
        new Date('2039-12-31T00:00:00Z'),
      );
    }
    await store.persist(
      {
        symbol: 'BTC-USD',
        interval: '5s',
        source: 'test-reconciled',
        candle: {
          timestamp: start,
          open: parsePrice('100'),
          high: parsePrice('105'),
          low: parsePrice('99'),
          close: parsePrice('104'),
          volume: parseQuantity('2'),
        },
      },
      new Date('2039-12-31T00:00:00Z'),
    );

    const latest = await store.load('BTC-USD', '5s', { limit: 2 });
    expect(latest.map((candle) => candle.timestamp.toISOString())).toEqual([
      '2040-01-01T00:00:05.000Z',
      '2040-01-01T00:00:10.000Z',
    ]);
    const older = await store.load('BTC-USD', '5s', {
      limit: 2,
      before: latest[0].timestamp,
    });
    expect(older).toHaveLength(1);
    expect(priceToString(older[0].close)).toBe('104.00000000');
  });
});
