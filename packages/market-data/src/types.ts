import {
  MARKET_REGISTRY,
  SUPPORTED_MARKET_SYMBOLS,
  type CanonicalMarketMetadata,
  type MarketSymbol,
  type Price,
  type Quantity,
} from '@trade-the-pool/shared';

export const SUPPORTED_SYMBOLS = SUPPORTED_MARKET_SYMBOLS;
export type { MarketSymbol } from '@trade-the-pool/shared';

export type MarketFreshnessStatus =
  'LIVE' | 'DELAYED' | 'STALE' | 'RECONNECTING' | 'UNAVAILABLE' | 'DEGRADED';
export type MarketAvailability = 'ACTIVE' | 'DEGRADED' | 'PAUSED' | 'DISABLED';
export type ProviderConnectionState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export type MarketPriceSnapshot = {
  symbol: MarketSymbol;
  price: Price;
  marketTimestamp: Date;
  receivedAt: Date;
  source: string;
  confidence?: Price;
  status?: MarketFreshnessStatus;
  executionEligible?: boolean;
};

export type AssetClass = 'CRYPTO';
export type MarketStatus = 'OPEN' | 'HALTED';
export type MarketMetadata = {
  symbol: MarketSymbol;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: 'USD';
  assetClass: AssetClass;
  tradingSchedule: '24/7';
  pricePrecision: number;
  quantityPrecision: number;
  status: MarketStatus;
  enabled: true;
  iconKey: string;
  accent: string;
  maxLeverage: CanonicalMarketMetadata['maxLeverage'];
  sortOrder: number;
  providerSymbols: { kraken: string; coinbase: string; pythFeedEnvironmentKey: string };
};

export const MARKET_METADATA: Readonly<Record<MarketSymbol, MarketMetadata>> = Object.fromEntries(
  SUPPORTED_SYMBOLS.map((symbol) => {
    const metadata = MARKET_REGISTRY[symbol];
    return [
      symbol,
      {
        symbol,
        displayName: metadata.displayName,
        baseCurrency: metadata.baseAsset,
        quoteCurrency: metadata.quoteAsset,
        assetClass: metadata.assetClass,
        tradingSchedule: metadata.schedule,
        pricePrecision: metadata.pricePrecision,
        quantityPrecision: metadata.quantityPrecision,
        status: 'OPEN',
        enabled: metadata.enabled,
        iconKey: metadata.iconKey,
        accent: metadata.accent,
        maxLeverage: metadata.maxLeverage,
        sortOrder: metadata.sortOrder,
        providerSymbols: metadata.providerSymbols,
      },
    ];
  }),
) as Record<MarketSymbol, MarketMetadata>;

export function canonicalSymbol(
  provider: 'kraken' | 'coinbase',
  value: string,
): MarketSymbol | null {
  return (
    SUPPORTED_SYMBOLS.find(
      (symbol) => MARKET_METADATA[symbol].providerSymbols[provider] === value,
    ) ?? null
  );
}

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
  volume: Quantity | null;
};

export interface MarketHistoryProvider extends MarketPriceProvider {
  getCandles(
    symbol: MarketSymbol,
    interval: CandleInterval,
    limit: number,
  ): Promise<MarketCandle[]> | MarketCandle[];
}

export type MarketStatistics = {
  change24hBasisPoints: bigint | null;
  high24h: Price | null;
  low24h: Price | null;
  volume24h: Quantity | null;
};

export type OrderBookLevel = { price: Price; quantity: Quantity; total: Quantity };
export type MarketOrderBook = {
  symbol: MarketSymbol;
  venue: 'Kraken' | 'Deterministic';
  status: MarketFreshnessStatus;
  timestamp: Date | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: Price | null;
  spreadBasisPoints: bigint | null;
};

export type MarketTrade = {
  id: string;
  symbol: MarketSymbol;
  price: Price;
  quantity: Quantity;
  side: 'BUY' | 'SELL' | null;
  timestamp: Date;
  venue: 'Kraken' | 'Deterministic';
};

export type MarketView = {
  symbol: MarketSymbol;
  exchangePrice: MarketPriceSnapshot | null;
  authoritativeMark: MarketPriceSnapshot | null;
  comparisonPrice: MarketPriceSnapshot | null;
  status: MarketFreshnessStatus;
  exchangeStatus: MarketFreshnessStatus;
  availability: MarketAvailability;
  statistics: MarketStatistics;
  deviationBasisPoints: bigint | null;
};

export type ProviderHealth = {
  provider: string;
  connection: ProviderConnectionState;
  lastMessageAt: Date | null;
  lastValidPriceAt: Date | null;
  lastBookUpdateAt: Date | null;
  lastTradeAt: Date | null;
  reconnectCount: number;
  orderBookResyncCount: number;
  lastError: string | null;
};

export type MarketDataHealth = {
  mode: 'fake' | 'live';
  components: {
    currentPrice: string;
    statistics24h: string;
    historicalCandles: string;
    realtimeCandles: string;
    orderBook: string;
    recentTrades: string;
    authoritativeMark: string;
    comparisonPrice: string;
  };
  symbolMappings: Array<{
    symbol: MarketSymbol;
    kraken: string;
    coinbase: string;
    pythFeedConfigured: boolean;
  }>;
  providers: ProviderHealth[];
  markets: Array<{
    symbol: MarketSymbol;
    status: MarketFreshnessStatus;
    exchangeStatus: MarketFreshnessStatus;
    availability: MarketAvailability;
    authoritativePriceAgeMs: number | null;
    exchangePriceAgeMs: number | null;
    deviationBasisPoints: string | null;
  }>;
};

export type NormalizedMarketEvent =
  | { type: 'price'; view: MarketView }
  | { type: 'book'; book: MarketOrderBook }
  | { type: 'trades'; symbol: MarketSymbol; trades: MarketTrade[] }
  | { type: 'candle'; symbol: MarketSymbol; interval: CandleInterval; candle: MarketCandle }
  | { type: 'status'; symbol: MarketSymbol; status: MarketFreshnessStatus }
  | { type: 'provider'; health: ProviderHealth };

export type MarketEventListener = (event: NormalizedMarketEvent) => void;

export interface MarketDataProvider extends MarketHistoryProvider {
  getMarkets(): readonly MarketMetadata[];
  getStatistics(symbol: MarketSymbol): MarketStatistics;
  getMarketView(symbol: MarketSymbol): MarketView;
  getOrderBook(symbol: MarketSymbol, depth?: number): MarketOrderBook;
  getRecentTrades(symbol: MarketSymbol, limit?: number): MarketTrade[];
  getHealth(): MarketDataHealth;
  subscribeMarketEvents(listener: MarketEventListener): () => void;
}

export interface StartableMarketDataProvider {
  start(): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface ControllableMarketPriceProvider extends ObservableMarketPriceProvider {
  advancePrice(symbol: MarketSymbol, price: string | Price, timestamp: Date): MarketPriceSnapshot;
}

export class MarketDataUnavailableError extends Error {
  constructor(
    readonly symbol: MarketSymbol,
    message = `Authoritative pricing is unavailable for ${symbol}`,
  ) {
    super(message);
    this.name = 'MarketDataUnavailableError';
  }
}
