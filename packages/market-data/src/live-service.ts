import type { Price } from '@trade-the-pool/shared';
import {
  CoinbaseMarketDataAdapter,
  KrakenMarketDataAdapter,
  PythHermesAdapter,
  type UpstreamEvent,
  type UpstreamMarketDataAdapter,
} from './providers.js';
import {
  MARKET_METADATA,
  SUPPORTED_SYMBOLS,
  MarketDataUnavailableError,
  type CandleInterval,
  type MarketAvailability,
  type MarketCandle,
  type MarketDataHealth,
  type MarketDataProvider,
  type MarketEventListener,
  type MarketFreshnessStatus,
  type MarketOrderBook,
  type MarketPriceListener,
  type MarketPriceSnapshot,
  type MarketStatistics,
  type MarketSymbol,
  type MarketTrade,
  type MarketView,
  type NormalizedMarketEvent,
  type ProviderHealth,
  type StartableMarketDataProvider,
} from './types.js';

export type FreshnessConfiguration = {
  authoritativeDelayedMs: number;
  authoritativeStaleMs: number;
  exchangeDelayedMs: number;
  exchangeStaleMs: number;
  bookStaleMs: number;
  comparisonStaleMs: number;
  maximumDeviationBasisPoints: bigint;
  futureTimestampToleranceMs: number;
};

export const DEFAULT_FRESHNESS_CONFIGURATION: FreshnessConfiguration = {
  authoritativeDelayedMs: 5_000,
  authoritativeStaleMs: 20_000,
  exchangeDelayedMs: 5_000,
  exchangeStaleMs: 30_000,
  bookStaleMs: 15_000,
  comparisonStaleMs: 30_000,
  maximumDeviationBasisPoints: 100n,
  futureTimestampToleranceMs: 2_000,
};

const EMPTY_STATISTICS: MarketStatistics = {
  change24hBasisPoints: null,
  high24h: null,
  low24h: null,
  volume24h: null,
};

type CacheEntry = { expiresAt: number; candles: MarketCandle[] };

function age(timestamp: Date | null | undefined, now = Date.now()): number | null {
  return timestamp ? now - timestamp.getTime() : null;
}

function cloneSnapshot(snapshot: MarketPriceSnapshot | undefined): MarketPriceSnapshot | null {
  return snapshot
    ? {
        ...snapshot,
        marketTimestamp: new Date(snapshot.marketTimestamp),
        receivedAt: new Date(snapshot.receivedAt),
      }
    : null;
}

function deviationBasisPoints(left: Price, right: Price): bigint {
  const midpoint = (left + right) / 2n;
  if (midpoint <= 0n) return 10_000n;
  const difference = left > right ? left - right : right - left;
  return (difference * 10_000n) / midpoint;
}

export class LiveMarketDataService implements MarketDataProvider, StartableMarketDataProvider {
  readonly #authoritative = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #exchange = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #comparison = new Map<MarketSymbol, MarketPriceSnapshot>();
  readonly #statistics = new Map<MarketSymbol, MarketStatistics>();
  readonly #books = new Map<MarketSymbol, MarketOrderBook>();
  readonly #trades = new Map<MarketSymbol, MarketTrade[]>();
  readonly #candles = new Map<string, CacheEntry>();
  readonly #inflightCandles = new Map<string, Promise<MarketCandle[]>>();
  readonly #providerHealth = new Map<string, ProviderHealth>();
  readonly #priceListeners = new Set<MarketPriceListener>();
  readonly #eventListeners = new Set<MarketEventListener>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #lastStatuses = new Map<MarketSymbol, MarketFreshnessStatus>();
  #statusTimer: NodeJS.Timeout | null = null;
  #started = false;

  constructor(
    private readonly adapters: {
      primary: UpstreamMarketDataAdapter;
      comparison: UpstreamMarketDataAdapter;
      authoritative: UpstreamMarketDataAdapter;
    },
    private readonly freshness: FreshnessConfiguration = DEFAULT_FRESHNESS_CONFIGURATION,
  ) {
    for (const adapter of Object.values(adapters))
      this.#providerHealth.set(adapter.name, adapter.getHealth());
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.#statistics.set(symbol, EMPTY_STATISTICS);
      this.#trades.set(symbol, []);
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const adapter of Object.values(this.adapters)) {
      this.#unsubscribers.push(adapter.subscribe((event) => this.onUpstreamEvent(event)));
      adapter.start();
    }
    this.#statusTimer = setInterval(() => this.publishStatusChanges(), 1_000);
    this.#statusTimer.unref();
  }

  async close(): Promise<void> {
    this.#started = false;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = null;
    while (this.#unsubscribers.length) this.#unsubscribers.pop()?.();
    await Promise.all(Object.values(this.adapters).map((adapter) => adapter.close()));
  }

  subscribe(listener: MarketPriceListener): () => void {
    this.#priceListeners.add(listener);
    return () => this.#priceListeners.delete(listener);
  }

  subscribeMarketEvents(listener: MarketEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  getSnapshot(symbol: MarketSymbol): MarketPriceSnapshot {
    const snapshot = this.#authoritative.get(symbol);
    if (!snapshot) throw new MarketDataUnavailableError(symbol);
    const view = this.getMarketView(symbol);
    return {
      ...snapshot,
      marketTimestamp: new Date(snapshot.marketTimestamp),
      receivedAt: new Date(snapshot.receivedAt),
      status: view.status,
      executionEligible: view.status === 'LIVE' || view.status === 'DELAYED',
    };
  }

  getMarkets() {
    return SUPPORTED_SYMBOLS.map((symbol) => MARKET_METADATA[symbol]);
  }

  getStatistics(symbol: MarketSymbol): MarketStatistics {
    return this.#statistics.get(symbol) ?? EMPTY_STATISTICS;
  }

  getMarketView(symbol: MarketSymbol): MarketView {
    const now = Date.now();
    const authoritative = this.#authoritative.get(symbol);
    const exchange = this.#exchange.get(symbol);
    const comparison = this.#comparison.get(symbol);
    const authoritativeAge = age(authoritative?.marketTimestamp, now);
    const exchangeAge = age(exchange?.marketTimestamp, now);
    const comparisonAge = age(comparison?.marketTimestamp, now);
    const pythHealth = this.#providerHealth.get(this.adapters.authoritative.name);
    const exchangeHealth = this.#providerHealth.get(this.adapters.primary.name);
    const validationComparisons = [
      exchangeAge !== null &&
      exchangeAge >= -this.freshness.futureTimestampToleranceMs &&
      exchangeAge <= this.freshness.comparisonStaleMs
        ? exchange
        : undefined,
      comparisonAge !== null &&
      comparisonAge >= -this.freshness.futureTimestampToleranceMs &&
      comparisonAge <= this.freshness.comparisonStaleMs
        ? comparison
        : undefined,
    ].filter((snapshot): snapshot is MarketPriceSnapshot => Boolean(snapshot));

    let exchangeStatus: MarketFreshnessStatus;
    if (!exchange) {
      exchangeStatus =
        exchangeHealth?.connection === 'CONNECTING' || exchangeHealth?.connection === 'RECONNECTING'
          ? 'RECONNECTING'
          : 'UNAVAILABLE';
    } else if (
      exchangeAge === null ||
      exchangeAge < -this.freshness.futureTimestampToleranceMs ||
      exchangeAge > this.freshness.exchangeStaleMs
    ) {
      exchangeStatus = 'STALE';
    } else {
      exchangeStatus = exchangeAge > this.freshness.exchangeDelayedMs ? 'DELAYED' : 'LIVE';
    }

    let status: MarketFreshnessStatus;
    if (!authoritative) {
      status =
        pythHealth?.connection === 'CONNECTING' || pythHealth?.connection === 'RECONNECTING'
          ? 'RECONNECTING'
          : 'UNAVAILABLE';
    } else if (
      authoritativeAge === null ||
      authoritativeAge < -this.freshness.futureTimestampToleranceMs ||
      authoritativeAge > this.freshness.authoritativeStaleMs
    ) {
      status = 'STALE';
    } else {
      const degraded = validationComparisons.some(
        (snapshot) =>
          deviationBasisPoints(authoritative.price, snapshot.price) >
          this.freshness.maximumDeviationBasisPoints,
      );
      status = degraded
        ? 'DEGRADED'
        : authoritativeAge > this.freshness.authoritativeDelayedMs
          ? 'DELAYED'
          : 'LIVE';
    }

    const availability: MarketAvailability =
      status === 'LIVE' || status === 'DELAYED'
        ? 'ACTIVE'
        : status === 'DEGRADED'
          ? 'DEGRADED'
          : 'PAUSED';
    const comparisonDeviation = authoritative
      ? validationComparisons.reduce<bigint | null>((highest, snapshot) => {
          const deviation = deviationBasisPoints(authoritative.price, snapshot.price);
          return highest === null || deviation > highest ? deviation : highest;
        }, null)
      : null;
    return {
      symbol,
      exchangePrice: cloneSnapshot(exchange),
      authoritativeMark: cloneSnapshot(authoritative),
      comparisonPrice: cloneSnapshot(comparison),
      status,
      exchangeStatus,
      availability,
      statistics: this.getStatistics(symbol),
      deviationBasisPoints: comparisonDeviation,
    };
  }

  getOrderBook(symbol: MarketSymbol, depth = 25): MarketOrderBook {
    const stored = this.#books.get(symbol);
    if (!stored)
      return {
        symbol,
        venue: 'Kraken',
        status:
          this.#providerHealth.get(this.adapters.primary.name)?.connection === 'RECONNECTING'
            ? 'RECONNECTING'
            : 'UNAVAILABLE',
        timestamp: null,
        bids: [],
        asks: [],
        spread: null,
        spreadBasisPoints: null,
      };
    const bookAge = age(stored.timestamp);
    const status =
      stored.status === 'RECONNECTING'
        ? 'RECONNECTING'
        : bookAge === null || bookAge > this.freshness.bookStaleMs
          ? 'STALE'
          : 'LIVE';
    return {
      ...stored,
      status,
      timestamp: stored.timestamp ? new Date(stored.timestamp) : null,
      bids: stored.bids.slice(0, depth),
      asks: stored.asks.slice(0, depth),
    };
  }

  getRecentTrades(symbol: MarketSymbol, limit = 50): MarketTrade[] {
    return (this.#trades.get(symbol) ?? [])
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((trade) => ({
        ...trade,
        timestamp: new Date(trade.timestamp),
      }));
  }

  async getCandles(
    symbol: MarketSymbol,
    interval: CandleInterval,
    limit: number,
  ): Promise<MarketCandle[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid candle request');
    const key = `${symbol}:${interval}:${limit}`;
    const cached = this.#candles.get(key);
    if (cached && cached.expiresAt > Date.now()) return this.cloneCandles(cached.candles);
    const inflight = this.#inflightCandles.get(key);
    if (inflight) return this.cloneCandles(await inflight);
    if (!this.adapters.primary.getCandles)
      throw new Error('Primary exchange does not provide candle history');
    const request = this.adapters.primary
      .getCandles(symbol, interval, limit)
      .then((candles) => {
        const normalized = this.reconcileCandles(candles);
        const ttl = Math.max(5_000, Math.min(60_000, this.intervalMs(interval) / 2));
        this.#candles.set(key, { expiresAt: Date.now() + ttl, candles: normalized });
        return normalized;
      })
      .finally(() => this.#inflightCandles.delete(key));
    this.#inflightCandles.set(key, request);
    return this.cloneCandles(await request);
  }

  getHealth(): MarketDataHealth {
    const now = Date.now();
    return {
      mode: 'live',
      components: {
        currentPrice: this.adapters.primary.name,
        statistics24h: this.adapters.primary.name,
        historicalCandles: `${this.adapters.primary.name}:rest-ohlc`,
        realtimeCandles: this.adapters.primary.name,
        orderBook: this.adapters.primary.name,
        recentTrades: this.adapters.primary.name,
        authoritativeMark: this.adapters.authoritative.name,
        comparisonPrice: this.adapters.comparison.name,
      },
      symbolMappings: SUPPORTED_SYMBOLS.map((symbol) => ({
        symbol,
        kraken: MARKET_METADATA[symbol].providerSymbols.kraken,
        coinbase: MARKET_METADATA[symbol].providerSymbols.coinbase,
        pythFeedConfigured: true,
      })),
      providers: [...this.#providerHealth.values()].map((health) => ({ ...health })),
      markets: SUPPORTED_SYMBOLS.map((symbol) => {
        const view = this.getMarketView(symbol);
        return {
          symbol,
          status: view.status,
          exchangeStatus: view.exchangeStatus,
          availability: view.availability,
          authoritativePriceAgeMs: age(view.authoritativeMark?.marketTimestamp, now),
          exchangePriceAgeMs: age(view.exchangePrice?.marketTimestamp, now),
          deviationBasisPoints: view.deviationBasisPoints?.toString() ?? null,
        };
      }),
    };
  }

  private onUpstreamEvent(event: UpstreamEvent): void {
    if (event.type === 'health') {
      this.#providerHealth.set(event.health.provider, event.health);
      this.publish({ type: 'provider', health: { ...event.health } });
      this.publishStatusChanges();
      return;
    }
    if (event.type === 'price') {
      if (!this.validSnapshot(event.snapshot)) return;
      const target =
        event.role === 'AUTHORITATIVE'
          ? this.#authoritative
          : event.role === 'PRIMARY_EXCHANGE'
            ? this.#exchange
            : this.#comparison;
      const current = target.get(event.snapshot.symbol);
      if (current && current.marketTimestamp > event.snapshot.marketTimestamp) return;
      target.set(event.snapshot.symbol, event.snapshot);
      if (event.statistics) this.#statistics.set(event.snapshot.symbol, event.statistics);
      if (event.role === 'AUTHORITATIVE') {
        const published = this.getSnapshot(event.snapshot.symbol);
        for (const listener of this.#priceListeners) listener(published);
      }
      this.publish({ type: 'price', view: this.getMarketView(event.snapshot.symbol) });
      return;
    }
    if (event.type === 'book') {
      this.#books.set(event.book.symbol, event.book);
      this.publish({ type: 'book', book: this.getOrderBook(event.book.symbol) });
      return;
    }
    if (event.type === 'trades') {
      const current = this.#trades.get(event.symbol) ?? [];
      const seen = new Set<string>();
      const merged = [...event.trades, ...current]
        .filter((trade) => {
          const key = `${trade.venue}:${trade.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((left, right) => +right.timestamp - +left.timestamp)
        .slice(0, 100);
      this.#trades.set(event.symbol, merged);
      this.publish({ type: 'trades', symbol: event.symbol, trades: event.trades });
      return;
    }
    this.mergeRealtimeCandle(event.symbol, event.interval, event.candle);
    this.publish(event);
  }

  private validSnapshot(snapshot: MarketPriceSnapshot): boolean {
    const timestamp = snapshot.marketTimestamp.getTime();
    const received = snapshot.receivedAt.getTime();
    return (
      SUPPORTED_SYMBOLS.includes(snapshot.symbol) &&
      snapshot.price > 0n &&
      snapshot.source.length > 0 &&
      snapshot.source.length <= 64 &&
      Number.isFinite(timestamp) &&
      Number.isFinite(received) &&
      timestamp <= received + this.freshness.futureTimestampToleranceMs
    );
  }

  private publish(event: NormalizedMarketEvent): void {
    for (const listener of this.#eventListeners) listener(event);
  }

  private publishStatusChanges(): void {
    for (const symbol of SUPPORTED_SYMBOLS) {
      const status = this.getMarketView(symbol).status;
      if (status === this.#lastStatuses.get(symbol)) continue;
      this.#lastStatuses.set(symbol, status);
      this.publish({ type: 'status', symbol, status });
      if (this.#exchange.has(symbol) || this.#authoritative.has(symbol))
        this.publish({ type: 'price', view: this.getMarketView(symbol) });
    }
  }

  private mergeRealtimeCandle(
    symbol: MarketSymbol,
    interval: CandleInterval,
    candle: MarketCandle,
  ): void {
    for (const [key, entry] of this.#candles) {
      if (!key.startsWith(`${symbol}:${interval}:`)) continue;
      const existing = entry.candles.findIndex(
        (item) => item.timestamp.getTime() === candle.timestamp.getTime(),
      );
      if (existing >= 0) entry.candles[existing] = candle;
      else entry.candles.push(candle);
      entry.candles.sort((left, right) => +left.timestamp - +right.timestamp);
      const limit = Number(key.split(':').at(-1));
      if (entry.candles.length > limit) entry.candles.splice(0, entry.candles.length - limit);
    }
  }

  private reconcileCandles(candles: MarketCandle[]): MarketCandle[] {
    const byTimestamp = new Map<number, MarketCandle>();
    for (const candle of candles) {
      if (
        !Number.isFinite(candle.timestamp.getTime()) ||
        candle.open <= 0n ||
        candle.high < candle.low ||
        candle.close <= 0n
      )
        continue;
      byTimestamp.set(candle.timestamp.getTime(), candle);
    }
    return [...byTimestamp.values()].sort((left, right) => +left.timestamp - +right.timestamp);
  }

  private cloneCandles(candles: MarketCandle[]): MarketCandle[] {
    return candles.map((candle) => ({ ...candle, timestamp: new Date(candle.timestamp) }));
  }

  private intervalMs(interval: CandleInterval): number {
    const values: Record<CandleInterval, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    };
    return values[interval];
  }
}

export type MarketDataFactoryConfiguration = {
  mode: 'live';
  krakenWsUrl: string;
  krakenRestUrl: string;
  coinbaseWsUrl: string;
  pythHermesUrl: string;
  pythApiKey?: string;
  pythFeedIds?: Record<MarketSymbol, string>;
  freshness?: Partial<{
    authoritativeDelayedMs: number;
    authoritativeStaleMs: number;
    exchangeDelayedMs: number;
    exchangeStaleMs: number;
    bookStaleMs: number;
    comparisonStaleMs: number;
    maximumDeviationBasisPoints: number;
    futureTimestampToleranceMs: number;
  }>;
};

export function createLiveMarketDataService(
  config: MarketDataFactoryConfiguration,
): LiveMarketDataService {
  if (!config.pythApiKey || !config.pythFeedIds)
    throw new Error('Live market data requires a Pyth API key and all configured feed IDs');
  const freshness: FreshnessConfiguration = {
    ...DEFAULT_FRESHNESS_CONFIGURATION,
    ...config.freshness,
    maximumDeviationBasisPoints: BigInt(
      config.freshness?.maximumDeviationBasisPoints ??
        DEFAULT_FRESHNESS_CONFIGURATION.maximumDeviationBasisPoints,
    ),
  };
  return new LiveMarketDataService(
    {
      primary: new KrakenMarketDataAdapter({
        wsUrl: config.krakenWsUrl,
        restUrl: config.krakenRestUrl,
        depth: 25,
      }),
      comparison: new CoinbaseMarketDataAdapter(config.coinbaseWsUrl),
      authoritative: new PythHermesAdapter({
        hermesUrl: config.pythHermesUrl,
        apiKey: config.pythApiKey,
        feedIds: config.pythFeedIds,
      }),
    },
    freshness,
  );
}
