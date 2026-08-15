import {
  CANDLE_INTERVAL_SECONDS,
  parsePrice,
  type Price,
  type Quantity,
} from '@trade-the-pool/shared';
import {
  MARKET_METADATA,
  SUPPORTED_SYMBOLS,
  type CandleInterval,
  type CandleHistoryRequest,
  type ControllableMarketPriceProvider,
  type MarketCandle,
  type MarketDataHealth,
  type MarketDataProvider,
  type MarketEventListener,
  type MarketOrderBook,
  type MarketPriceListener,
  type MarketPriceSnapshot,
  type MarketStatistics,
  type MarketSymbol,
  type MarketTrade,
  type MarketView,
} from './types.js';

const INITIAL_PRICES: Record<MarketSymbol, string> = {
  'BTC-USD': '100000.00',
  'ETH-USD': '4000.00',
  'SOL-USD': '200.00',
  'XRP-USD': '2.40',
  'DOGE-USD': '0.22',
  'LINK-USD': '18.00',
  'AVAX-USD': '35.00',
  'ADA-USD': '0.78',
  'SUI-USD': '3.20',
  'AAVE-USD': '280.00',
  'NEAR-USD': '5.40',
  'LTC-USD': '115.00',
};

export const INTERVAL_MS: Record<CandleInterval, number> = {
  ...Object.fromEntries(
    Object.entries(CANDLE_INTERVAL_SECONDS).map(([interval, seconds]) => [
      interval,
      seconds * 1_000,
    ]),
  ),
} as Record<CandleInterval, number>;

export class DeterministicMarketPriceSource
  implements ControllableMarketPriceProvider, MarketDataProvider
{
  readonly source = 'deterministic-memory-v1';
  readonly #snapshots = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #history = new Map<MarketSymbol, MarketPriceSnapshot[]>();
  readonly #trades = new Map<MarketSymbol, MarketTrade[]>();
  readonly #listeners = new Set<MarketPriceListener>();
  readonly #eventListeners = new Set<MarketEventListener>();

  constructor(initialTimestamp = new Date()) {
    for (const [symbolIndex, symbol] of SUPPORTED_SYMBOLS.entries()) {
      const base = parsePrice(INITIAL_PRICES[symbol]);
      const ticks: MarketPriceSnapshot[] = [];
      for (let minute = 1_439; minute >= 0; minute -= 1) {
        const sequence = 1_439 - minute;
        const wave = ((sequence * 17 + symbolIndex * 13) % 121) - 60;
        const trend = Math.floor(sequence / 240) - 3;
        const offsetBps = BigInt(wave + trend * 4);
        const price = (base + (base * offsetBps) / 10_000n) as Price;
        const marketTimestamp = new Date(initialTimestamp.getTime() - minute * 60_000);
        ticks.push({
          symbol,
          price,
          marketTimestamp,
          receivedAt: new Date(marketTimestamp),
          source: this.source,
          status: 'LIVE',
          executionEligible: true,
        });
      }
      const current = {
        symbol,
        price: base,
        marketTimestamp: new Date(initialTimestamp),
        receivedAt: new Date(initialTimestamp),
        source: this.source,
        status: 'LIVE' as const,
        executionEligible: true,
      };
      ticks.push(current);
      this.#history.set(symbol, ticks);
      this.#snapshots.set(symbol, current);
      this.#trades.set(symbol, []);
    }
  }

  getPrice(symbol: MarketSymbol): Price {
    return this.getSnapshot(symbol).price;
  }

  getSnapshot(symbol: MarketSymbol): MarketPriceSnapshot {
    const snapshot = this.#snapshots.get(symbol);
    if (!snapshot) throw new Error(`Unsupported market symbol: ${symbol}`);
    return {
      ...snapshot,
      marketTimestamp: new Date(snapshot.marketTimestamp),
      receivedAt: new Date(snapshot.receivedAt),
    };
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
    const snapshot: MarketPriceSnapshot = {
      symbol,
      price: exactPrice,
      marketTimestamp: new Date(timestamp),
      receivedAt: new Date(timestamp),
      source: this.source,
      status: 'LIVE',
      executionEligible: true,
    };
    this.#snapshots.set(symbol, snapshot);
    const history = this.#history.get(symbol) ?? [];
    history.push(snapshot);
    if (history.length > 4_000) history.splice(0, history.length - 4_000);
    this.#history.set(symbol, history);
    const trade: MarketTrade = {
      id: `fake-${symbol}-${timestamp.getTime()}`,
      symbol,
      price: exactPrice,
      quantity: (1_000_000n + BigInt(timestamp.getTime() % 9_000_000)) as Quantity,
      side: exactPrice >= current.price ? 'BUY' : 'SELL',
      timestamp: new Date(timestamp),
      venue: 'Deterministic',
    };
    const trades = [trade, ...(this.#trades.get(symbol) ?? [])].slice(0, 100);
    this.#trades.set(symbol, trades);
    const published = this.getSnapshot(symbol);
    for (const listener of this.#listeners) listener(published);
    const view = this.getMarketView(symbol);
    for (const listener of this.#eventListeners) {
      listener({ type: 'price', view });
      listener({ type: 'trades', symbol, trades: [trade] });
      for (const interval of Object.keys(INTERVAL_MS) as CandleInterval[]) {
        const candle = this.getCandles(symbol, interval, 1)[0];
        if (candle) listener({ type: 'candle', symbol, interval, candle });
      }
      listener({ type: 'book', book: this.getOrderBook(symbol) });
    }
    return published;
  }

  subscribe(listener: MarketPriceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeMarketEvents(listener: MarketEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  getMarkets() {
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
    const short = this.getCandles(symbol, '5m', 4);
    const latestShort = short.at(-1)!;
    return {
      change24hBasisPoints: ((current.price - first.price) * 10_000n) / first.price,
      high24h: high,
      low24h: low,
      volume24h: null,
      change15mBasisPoints: ((latestShort.close - short[0].open) * 10_000n) / short[0].open,
      range5mBasisPoints: ((latestShort.high - latestShort.low) * 10_000n) / latestShort.close,
    };
  }

  getMarketView(symbol: MarketSymbol): MarketView {
    const snapshot = this.getSnapshot(symbol);
    return {
      symbol,
      exchangePrice: snapshot,
      authoritativeMark: snapshot,
      comparisonPrice: snapshot,
      status: 'LIVE',
      exchangeStatus: 'LIVE',
      availability: 'ACTIVE',
      statistics: this.getStatistics(symbol),
      deviationBasisPoints: 0n,
    };
  }

  getCandles(
    symbol: MarketSymbol,
    interval: CandleInterval,
    request: number | CandleHistoryRequest,
  ): MarketCandle[] {
    const normalizedRequest = typeof request === 'number' ? { limit: request } : request;
    const { limit, before } = normalizedRequest;
    const intervalMs = INTERVAL_MS[interval];
    if (
      !intervalMs ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1_000 ||
      (before && !Number.isFinite(before.getTime()))
    )
      throw new Error('Invalid candle request');
    const snapshot = this.getSnapshot(symbol);
    const currentBucket = Math.floor(snapshot.marketTimestamp.getTime() / intervalMs) * intervalMs;
    const endExclusive = before?.getTime() ?? currentBucket + intervalMs;
    const lastTimestamp = Math.floor((endExclusive - 1) / intervalMs) * intervalMs;
    const base = parsePrice(INITIAL_PRICES[symbol]);
    const priceAt = (timestamp: number): Price => {
      const sequence = Math.floor(timestamp / Math.max(1_000, intervalMs));
      const wave = ((sequence * 17 + MARKET_METADATA[symbol].sortOrder) % 121) - 60;
      const trend = (sequence % 480) - 240;
      return (base + (base * BigInt(wave * 2 + Math.trunc(trend / 24))) / 100_000n) as Price;
    };
    return Array.from({ length: limit }, (_, index) => {
      const timestamp = lastTimestamp - (limit - index - 1) * intervalMs;
      const isCurrent = !before && timestamp === currentBucket;
      const open = priceAt(timestamp - intervalMs);
      const close = isCurrent ? snapshot.price : priceAt(timestamp);
      const upper = open > close ? open : close;
      const lower = open < close ? open : close;
      const wick = (base * BigInt(Math.abs(Math.floor(timestamp / intervalMs) % 9) + 1)) / 100_000n;
      return {
        timestamp: new Date(timestamp),
        open,
        high: (upper + wick) as Price,
        low: (lower > wick ? lower - wick : 1n) as Price,
        close,
        volume: (1_000_000n +
          BigInt(Math.abs(Math.floor(timestamp / 1_000) % 997)) * 10_000n) as Quantity,
      };
    });
  }

  getOrderBook(symbol: MarketSymbol, depth = 25): MarketOrderBook {
    const price = this.getSnapshot(symbol).price;
    const levelCount = Math.max(1, Math.min(50, depth));
    let bidTotal = 0n;
    let askTotal = 0n;
    const bids = Array.from({ length: levelCount }, (_, index) => {
      const quantity = BigInt((index + 1) * 12_500_000) as Quantity;
      bidTotal += quantity;
      return {
        price: (price - (price * BigInt(index + 1)) / 100_000n) as Price,
        quantity,
        total: bidTotal as Quantity,
      };
    });
    const asks = Array.from({ length: levelCount }, (_, index) => {
      const quantity = BigInt((levelCount - index) * 11_000_000) as Quantity;
      askTotal += quantity;
      return {
        price: (price + (price * BigInt(index + 1)) / 100_000n) as Price,
        quantity,
        total: askTotal as Quantity,
      };
    });
    const spread = (asks[0].price - bids[0].price) as Price;
    return {
      symbol,
      venue: 'Deterministic',
      status: 'LIVE',
      timestamp: this.getSnapshot(symbol).marketTimestamp,
      bids,
      asks,
      spread,
      spreadBasisPoints: (spread * 10_000n) / price,
    };
  }

  getRecentTrades(symbol: MarketSymbol, limit = 50): MarketTrade[] {
    return (this.#trades.get(symbol) ?? []).slice(0, Math.max(1, Math.min(100, limit)));
  }

  getHealth(): MarketDataHealth {
    return {
      mode: 'fake',
      components: {
        currentPrice: this.source,
        statistics24h: this.source,
        historicalCandles: this.source,
        realtimeCandles: this.source,
        subMinuteCandles: `${this.source}:simulated`,
        orderBook: this.source,
        recentTrades: this.source,
        authoritativeMark: this.source,
        comparisonPrice: this.source,
      },
      symbolMappings: SUPPORTED_SYMBOLS.map((symbol) => ({
        symbol,
        kraken: MARKET_METADATA[symbol].providerSymbols.kraken,
        coinbase: MARKET_METADATA[symbol].providerSymbols.coinbase,
        pythFeedConfigured: false,
      })),
      providers: [
        {
          provider: this.source,
          connection: 'CONNECTED',
          lastMessageAt: new Date(),
          lastValidPriceAt: new Date(),
          lastBookUpdateAt: new Date(),
          lastTradeAt: null,
          reconnectCount: 0,
          orderBookResyncCount: 0,
          lastError: null,
        },
      ],
      subMinute: SUPPORTED_SYMBOLS.map((symbol) => ({
        symbol,
        lastTradeReceived: this.#trades.get(symbol)?.[0]?.timestamp ?? null,
        lastOneSecondCandleFinalized: this.getSnapshot(symbol).marketTimestamp,
        bufferSizes: { '1s': 500, '5s': 500, '15s': 500, '30s': 500 },
        aggregationLagMs: 0,
      })),
      markets: SUPPORTED_SYMBOLS.map((symbol) => ({
        symbol,
        status: 'LIVE',
        exchangeStatus: 'LIVE',
        availability: 'ACTIVE',
        authoritativePriceAgeMs: Math.max(
          0,
          Date.now() - this.getSnapshot(symbol).marketTimestamp.getTime(),
        ),
        exchangePriceAgeMs: Math.max(
          0,
          Date.now() - this.getSnapshot(symbol).marketTimestamp.getTime(),
        ),
        deviationBasisPoints: '0',
      })),
    };
  }
}
