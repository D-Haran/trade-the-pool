import { and, desc, eq, lt } from 'drizzle-orm';
import { subMinuteCandles, type Database } from '@trade-the-pool/database';
import type {
  CandleHistoryRequest,
  MarketCandle,
  MarketSymbol,
  PersistedSubMinuteCandle,
  PersistedSubMinuteInterval,
  SubMinuteCandleStore,
} from '@trade-the-pool/market-data';
import { parsePrice, parseQuantity, priceToString, quantityToString } from '@trade-the-pool/shared';

export class PostgresSubMinuteCandleStore implements SubMinuteCandleStore {
  readonly #lastPruned = new Map<string, number>();

  constructor(private readonly db: Database) {}

  async load(
    symbol: MarketSymbol,
    interval: PersistedSubMinuteInterval,
    request: CandleHistoryRequest,
  ): Promise<MarketCandle[]> {
    const filters = [
      eq(subMinuteCandles.symbol, symbol),
      eq(subMinuteCandles.interval, interval),
      ...(request.before ? [lt(subMinuteCandles.timestamp, request.before)] : []),
    ];
    const rows = await this.db
      .select()
      .from(subMinuteCandles)
      .where(and(...filters))
      .orderBy(desc(subMinuteCandles.timestamp))
      .limit(request.limit);
    return rows.reverse().map((row) => ({
      timestamp: row.timestamp,
      open: parsePrice(row.open),
      high: parsePrice(row.high),
      low: parsePrice(row.low),
      close: parsePrice(row.close),
      volume: parseQuantity(row.volume),
    }));
  }

  async persist(record: PersistedSubMinuteCandle, retentionCutoff: Date): Promise<void> {
    const values = {
      symbol: record.symbol,
      interval: record.interval,
      timestamp: record.candle.timestamp,
      open: priceToString(record.candle.open),
      high: priceToString(record.candle.high),
      low: priceToString(record.candle.low),
      close: priceToString(record.candle.close),
      volume: quantityToString(record.candle.volume ?? parseQuantity('0')),
      source: record.source,
    };
    await this.db
      .insert(subMinuteCandles)
      .values(values)
      .onConflictDoUpdate({
        target: [subMinuteCandles.symbol, subMinuteCandles.interval, subMinuteCandles.timestamp],
        set: {
          open: values.open,
          high: values.high,
          low: values.low,
          close: values.close,
          volume: values.volume,
          source: values.source,
        },
      });

    const key = `${record.symbol}:${record.interval}`;
    const now = Date.now();
    if (now - (this.#lastPruned.get(key) ?? 0) < 60_000) return;
    this.#lastPruned.set(key, now);
    await this.db
      .delete(subMinuteCandles)
      .where(
        and(
          eq(subMinuteCandles.symbol, record.symbol),
          eq(subMinuteCandles.interval, record.interval),
          lt(subMinuteCandles.timestamp, retentionCutoff),
        ),
      );
  }
}
