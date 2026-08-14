import { parsePrice, type Price, type Quantity } from '@trade-the-pool/shared';

export const SUPPORTED_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
export type MarketSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export type MarketPriceSnapshot = {
  symbol: MarketSymbol;
  price: Price;
  marketTimestamp: Date;
  source: string;
};

export type AssetClass = 'CRYPTO';
export type MarketStatus = 'OPEN' | 'HALTED';
export type MarketMetadata = {
  symbol: MarketSymbol;
  baseCurrency: 'BTC' | 'ETH' | 'SOL';
  quoteCurrency: 'USD';
  assetClass: AssetClass;
  tradingSchedule: '24/7';
  pricePrecision: number;
  quantityPrecision: number;
  status: MarketStatus;
};

export const MARKET_METADATA: Readonly<Record<MarketSymbol, MarketMetadata>> = {
  'BTC-USD': {
    symbol: 'BTC-USD',
    baseCurrency: 'BTC',
    quoteCurrency: 'USD',
    assetClass: 'CRYPTO',
    tradingSchedule: '24/7',
    pricePrecision: 2,
    quantityPrecision: 8,
    status: 'OPEN',
  },
  'ETH-USD': {
    symbol: 'ETH-USD',
    baseCurrency: 'ETH',
    quoteCurrency: 'USD',
    assetClass: 'CRYPTO',
    tradingSchedule: '24/7',
    pricePrecision: 2,
    quantityPrecision: 8,
    status: 'OPEN',
  },
  'SOL-USD': {
    symbol: 'SOL-USD',
    baseCurrency: 'SOL',
    quoteCurrency: 'USD',
    assetClass: 'CRYPTO',
    tradingSchedule: '24/7',
    pricePrecision: 2,
    quantityPrecision: 8,
    status: 'OPEN',
  },
};

/** Port consumed by the trading engine. Implementations, not callers, own prices and timestamps. */
export interface MarketPriceProvider {
  getSnapshot(symbol: MarketSymbol): Promise<MarketPriceSnapshot> | MarketPriceSnapshot;
}

export type MarketPriceListener = (snapshot: MarketPriceSnapshot) => void;
export interface ObservableMarketPriceProvider extends MarketPriceProvider {
  subscribe(listener: MarketPriceListener): () => void;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type MarketCandle = {
  timestamp: Date;
  open: Price;
  high: Price;
  low: Price;
  close: Price;
};

export interface MarketHistoryProvider extends MarketPriceProvider {
  getCandles(symbol: MarketSymbol, interval: CandleInterval, limit: number): MarketCandle[];
}

export type MarketStatistics = {
  change24hBasisPoints: bigint | null;
  high24h: Price | null;
  low24h: Price | null;
  volume24h: Quantity | null;
};

export interface MarketDataProvider extends MarketHistoryProvider {
  getMarkets(): readonly MarketMetadata[];
  getStatistics(symbol: MarketSymbol): MarketStatistics;
}

export interface ControllableMarketPriceProvider extends ObservableMarketPriceProvider {
  advancePrice(symbol: MarketSymbol, price: string | Price, timestamp: Date): MarketPriceSnapshot;
}

const INITIAL_PRICES: Record<MarketSymbol, string> = {
  'BTC-USD': '100000.00',
  'ETH-USD': '4000.00',
  'SOL-USD': '200.00',
};

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export class DeterministicMarketPriceSource
  implements ControllableMarketPriceProvider, MarketDataProvider
{
  readonly source = 'deterministic-memory-v1';
  readonly #snapshots = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #history = new Map<MarketSymbol, MarketPriceSnapshot[]>();
  readonly #listeners = new Set<MarketPriceListener>();

  constructor(initialTimestamp = new Date()) {
    for (const [symbolIndex, symbol] of SUPPORTED_SYMBOLS.entries()) {
      const base = parsePrice(INITIAL_PRICES[symbol]);
      const ticks: MarketPriceSnapshot[] = [];
      for (let minute = 1_439; minute >= 0; minute -= 1) {
        const sequence = 1_439 - minute;
        const offsetBps = BigInt(((sequence * 17 + symbolIndex * 13) % 121) - 60);
        const price = (base + (base * offsetBps) / 10_000n) as Price;
        const marketTimestamp = new Date(initialTimestamp.getTime() - minute * 60_000);
        ticks.push({ symbol, price, marketTimestamp, source: this.source });
      }
      const current = {
        symbol,
        price: base,
        marketTimestamp: new Date(initialTimestamp),
        source: this.source,
      };
      ticks.push(current);
      this.#history.set(symbol, ticks);
      this.#snapshots.set(symbol, current);
    }
  }

  getPrice(symbol: MarketSymbol): Price {
    return this.getSnapshot(symbol).price;
  }

  getSnapshot(symbol: MarketSymbol): MarketPriceSnapshot {
    const snapshot = this.#snapshots.get(symbol);
    if (!snapshot) throw new Error(`Unsupported market symbol: ${symbol}`);
    return { ...snapshot, marketTimestamp: new Date(snapshot.marketTimestamp) };
  }

  setPrice(symbol: MarketSymbol, price: string | Price): MarketPriceSnapshot {
    const current = this.getSnapshot(symbol);
    return this.advancePrice(symbol, price, current.marketTimestamp);
  }

  advancePrice(symbol: MarketSymbol, price: string | Price, timestamp: Date): MarketPriceSnapshot {
    const exactPrice = typeof price === 'string' ? parsePrice(price) : price;
    const current = this.getSnapshot(symbol);
    if (timestamp < current.marketTimestamp)
      throw new Error('Market timestamp cannot move backwards');
    const snapshot = {
      symbol,
      price: exactPrice,
      marketTimestamp: new Date(timestamp),
      source: this.source,
    };
    this.#snapshots.set(symbol, snapshot);
    const history = this.#history.get(symbol) ?? [];
    history.push(snapshot);
    if (history.length > 4_000) history.splice(0, history.length - 4_000);
    this.#history.set(symbol, history);
    const published = this.getSnapshot(symbol);
    for (const listener of this.#listeners) listener(published);
    return published;
  }

  subscribe(listener: MarketPriceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getMarkets(): readonly MarketMetadata[] {
    return SUPPORTED_SYMBOLS.map((symbol) => MARKET_METADATA[symbol]);
  }

  getStatistics(symbol: MarketSymbol): MarketStatistics {
    const current = this.getSnapshot(symbol);
    const cutoff = current.marketTimestamp.getTime() - 24 * 60 * 60_000;
    const ticks = (this.#history.get(symbol) ?? []).filter(
      (tick) => tick.marketTimestamp.getTime() >= cutoff,
    );
    const first = ticks[0];
    if (!first) return { change24hBasisPoints: null, high24h: null, low24h: null, volume24h: null };
    let high = first.price;
    let low = first.price;
    for (const tick of ticks) {
      if (tick.price > high) high = tick.price;
      if (tick.price < low) low = tick.price;
    }
    return {
      change24hBasisPoints: ((current.price - first.price) * 10_000n) / first.price,
      high24h: high,
      low24h: low,
      volume24h: null,
    };
  }

  getCandles(symbol: MarketSymbol, interval: CandleInterval, limit: number): MarketCandle[] {
    const intervalMs = INTERVAL_MS[interval];
    if (!intervalMs || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid candle request');
    const candles = new Map<number, MarketCandle>();
    for (const tick of this.#history.get(symbol) ?? []) {
      const timestamp = Math.floor(tick.marketTimestamp.getTime() / intervalMs) * intervalMs;
      const candle = candles.get(timestamp);
      if (!candle) {
        candles.set(timestamp, {
          timestamp: new Date(timestamp),
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
        });
      } else {
        candle.high = tick.price > candle.high ? tick.price : candle.high;
        candle.low = tick.price < candle.low ? tick.price : candle.low;
        candle.close = tick.price;
      }
    }
    return [...candles.values()].sort((a, b) => +a.timestamp - +b.timestamp).slice(-limit);
  }
}
