import type { Quantity } from '@trade-the-pool/shared';
import type { CandleInterval, MarketCandle, MarketSymbol, MarketTrade } from './types.js';

export const SUB_MINUTE_INTERVAL_MS = {
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '30s': 30_000,
} as const satisfies Partial<Record<CandleInterval, number>>;

export type SubMinuteInterval = keyof typeof SUB_MINUTE_INTERVAL_MS;

/** Bounded in-process history; restart recovery intentionally begins with new genuine trades. */
export const DEFAULT_SUB_MINUTE_RETENTION: Record<SubMinuteInterval, number> = {
  '1s': 2 * 60 * 60,
  '5s': (12 * 60 * 60) / 5,
  '15s': (24 * 60 * 60) / 15,
  '30s': (48 * 60 * 60) / 30,
};

type CurrentSecond = { candle: MarketCandle; hasTrade: boolean; lastTradeTimestamp: number | null };
type SymbolState = {
  current: CurrentSecond | null;
  buffers: Record<SubMinuteInterval, MarketCandle[]>;
  lastTradeReceived: Date | null;
  lastFinalized: Date | null;
};

const clone = (candle: MarketCandle): MarketCandle => ({
  ...candle,
  timestamp: new Date(candle.timestamp),
});

export class SubMinuteCandleAggregator {
  readonly #states = new Map<MarketSymbol, SymbolState>();

  constructor(
    symbols: readonly MarketSymbol[],
    private readonly publish: (
      symbol: MarketSymbol,
      interval: SubMinuteInterval,
      candle: MarketCandle,
    ) => void,
    private readonly retention = DEFAULT_SUB_MINUTE_RETENTION,
  ) {
    for (const symbol of symbols)
      this.#states.set(symbol, {
        current: null,
        buffers: { '1s': [], '5s': [], '15s': [], '30s': [] },
        lastTradeReceived: null,
        lastFinalized: null,
      });
  }

  ingestTrades(symbol: MarketSymbol, trades: readonly MarketTrade[]): void {
    for (const trade of [...trades].sort((left, right) => +left.timestamp - +right.timestamp))
      this.ingestTrade(symbol, trade);
  }

  ingestTrade(symbol: MarketSymbol, trade: MarketTrade): boolean {
    const state = this.#states.get(symbol);
    if (!state || trade.symbol !== symbol || trade.price <= 0n || trade.quantity < 0n) return false;
    const time = trade.timestamp.getTime();
    if (!Number.isFinite(time)) return false;
    const bucket = Math.floor(time / 1_000) * 1_000;
    if (state.current && bucket < state.current.candle.timestamp.getTime()) return false;
    if (
      state.current?.lastTradeTimestamp !== null &&
      state.current?.lastTradeTimestamp !== undefined &&
      time < state.current.lastTradeTimestamp
    )
      return false;

    if (!state.current) {
      state.current = {
        candle: this.tradeCandle(bucket, trade),
        hasTrade: true,
        lastTradeTimestamp: time,
      };
    } else {
      this.advanceSymbol(state, symbol, bucket);
      const current = state.current;
      if (!current || current.candle.timestamp.getTime() !== bucket) return false;
      if (!current.hasTrade) {
        current.candle = this.tradeCandle(bucket, trade);
        current.hasTrade = true;
      } else {
        current.candle.high = trade.price > current.candle.high ? trade.price : current.candle.high;
        current.candle.low = trade.price < current.candle.low ? trade.price : current.candle.low;
        current.candle.close = trade.price;
        current.candle.volume = ((current.candle.volume ?? 0n) + trade.quantity) as Quantity;
      }
      current.lastTradeTimestamp = time;
    }
    state.lastTradeReceived = new Date();
    this.upsertOneSecond(symbol, state, state.current.candle);
    return true;
  }

  /** Advances UTC seconds and emits flat zero-volume bars only after a genuine seed price exists. */
  advanceTo(timestamp: Date): void {
    const bucket = Math.floor(timestamp.getTime() / 1_000) * 1_000;
    if (!Number.isFinite(bucket)) return;
    for (const [symbol, state] of this.#states) this.advanceSymbol(state, symbol, bucket);
  }

  advanceSymbolTo(symbol: MarketSymbol, timestamp: Date): void {
    const bucket = Math.floor(timestamp.getTime() / 1_000) * 1_000;
    const state = this.#states.get(symbol);
    if (state && Number.isFinite(bucket)) this.advanceSymbol(state, symbol, bucket);
  }

  getCandles(symbol: MarketSymbol, interval: SubMinuteInterval, limit: number): MarketCandle[] {
    return (this.#states.get(symbol)?.buffers[interval] ?? []).slice(-limit).map(clone);
  }

  diagnostics(symbol: MarketSymbol, now = Date.now()) {
    const state = this.#states.get(symbol)!;
    return {
      symbol,
      lastTradeReceived: state.lastTradeReceived ? new Date(state.lastTradeReceived) : null,
      lastOneSecondCandleFinalized: state.lastFinalized ? new Date(state.lastFinalized) : null,
      bufferSizes: {
        '1s': state.buffers['1s'].length,
        '5s': state.buffers['5s'].length,
        '15s': state.buffers['15s'].length,
        '30s': state.buffers['30s'].length,
      },
      aggregationLagMs: state.lastFinalized
        ? Math.max(0, now - state.lastFinalized.getTime() - 1_000)
        : null,
    };
  }

  private tradeCandle(bucket: number, trade: MarketTrade): MarketCandle {
    return {
      timestamp: new Date(bucket),
      open: trade.price,
      high: trade.price,
      low: trade.price,
      close: trade.price,
      volume: trade.quantity,
    };
  }

  private advanceSymbol(state: SymbolState, symbol: MarketSymbol, targetBucket: number): void {
    while (state.current && state.current.candle.timestamp.getTime() < targetBucket) {
      state.lastFinalized = new Date(state.current.candle.timestamp);
      this.upsertOneSecond(symbol, state, state.current.candle);
      const nextTimestamp = state.current.candle.timestamp.getTime() + 1_000;
      const close = state.current.candle.close;
      state.current = {
        hasTrade: false,
        lastTradeTimestamp: null,
        candle: {
          timestamp: new Date(nextTimestamp),
          open: close,
          high: close,
          low: close,
          close,
          volume: 0n as Quantity,
        },
      };
      this.upsertOneSecond(symbol, state, state.current.candle);
    }
  }

  private upsertOneSecond(symbol: MarketSymbol, state: SymbolState, candle: MarketCandle): void {
    this.upsert(state.buffers['1s'], candle, this.retention['1s']);
    this.publish(symbol, '1s', clone(candle));
    for (const interval of ['5s', '15s', '30s'] as const) {
      const duration = SUB_MINUTE_INTERVAL_MS[interval];
      const bucket = Math.floor(candle.timestamp.getTime() / duration) * duration;
      const children: MarketCandle[] = [];
      for (let index = state.buffers['1s'].length - 1; index >= 0; index -= 1) {
        const child = state.buffers['1s'][index];
        const timestamp = child.timestamp.getTime();
        if (timestamp < bucket) break;
        if (timestamp < bucket + duration) children.push(child);
      }
      children.reverse();
      if (!children.length) continue;
      const aggregate: MarketCandle = {
        timestamp: new Date(bucket),
        open: children[0].open,
        high: children.reduce(
          (value, child) => (child.high > value ? child.high : value),
          children[0].high,
        ),
        low: children.reduce(
          (value, child) => (child.low < value ? child.low : value),
          children[0].low,
        ),
        close: children.at(-1)!.close,
        volume: children.reduce((total, child) => total + (child.volume ?? 0n), 0n) as Quantity,
      };
      this.upsert(state.buffers[interval], aggregate, this.retention[interval]);
      this.publish(symbol, interval, clone(aggregate));
    }
  }

  private upsert(buffer: MarketCandle[], candle: MarketCandle, limit: number): void {
    const timestamp = candle.timestamp.getTime();
    const existing = buffer.findIndex((item) => item.timestamp.getTime() === timestamp);
    if (existing >= 0) buffer[existing] = clone(candle);
    else buffer.push(clone(candle));
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  }
}
