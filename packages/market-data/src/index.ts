import { parsePrice, type Price } from '@trade-the-pool/shared';

export const SUPPORTED_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
export type MarketSymbol = (typeof SUPPORTED_SYMBOLS)[number];

export type MarketPriceSnapshot = {
  symbol: MarketSymbol;
  price: Price;
  marketTimestamp: Date;
  source: string;
};

/** Port consumed by the trading engine. Implementations, not callers, own prices and timestamps. */
export interface MarketPriceProvider {
  getSnapshot(symbol: MarketSymbol): Promise<MarketPriceSnapshot> | MarketPriceSnapshot;
}

export type MarketPriceListener = (snapshot: MarketPriceSnapshot) => void;
export interface ObservableMarketPriceProvider extends MarketPriceProvider {
  subscribe(listener: MarketPriceListener): () => void;
}

const INITIAL_PRICES: Record<MarketSymbol, string> = {
  'BTC-USD': '100000.00',
  'ETH-USD': '4000.00',
  'SOL-USD': '200.00',
};

export class DeterministicMarketPriceSource implements MarketPriceProvider {
  readonly source = 'deterministic-memory-v1';
  readonly #snapshots = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #listeners = new Set<MarketPriceListener>();

  constructor(initialTimestamp = new Date()) {
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.#snapshots.set(symbol, {
        symbol,
        price: parsePrice(INITIAL_PRICES[symbol]),
        marketTimestamp: new Date(initialTimestamp),
        source: this.source,
      });
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
    const published = this.getSnapshot(symbol);
    for (const listener of this.#listeners) listener(published);
    return published;
  }

  subscribe(listener: MarketPriceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
