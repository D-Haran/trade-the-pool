export const SUPPORTED_MARKET_SYMBOLS = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'DOGE-USD',
  'LINK-USD',
  'AVAX-USD',
  'ADA-USD',
  'SUI-USD',
  'AAVE-USD',
  'NEAR-USD',
  'LTC-USD',
] as const;

export type MarketSymbol = (typeof SUPPORTED_MARKET_SYMBOLS)[number];
export type Leverage = 1 | 2 | 3 | 4 | 5;

export type CanonicalMarketMetadata = {
  symbol: MarketSymbol;
  displayName: string;
  baseAsset: string;
  quoteAsset: 'USD';
  assetClass: 'CRYPTO';
  enabled: true;
  pricePrecision: number;
  quantityPrecision: number;
  schedule: '24/7';
  iconKey: string;
  accent: string;
  maxLeverage: Leverage;
  sortOrder: number;
  providerSymbols: {
    kraken: string;
    coinbase: string;
    pythFeedEnvironmentKey: `PYTH_FEED_ID_${string}_USD`;
  };
};

const market = (
  symbol: MarketSymbol,
  displayName: string,
  maxLeverage: Leverage,
  sortOrder: number,
  accent: string,
): CanonicalMarketMetadata => {
  const baseAsset = symbol.slice(0, -4);
  return {
    symbol,
    displayName,
    baseAsset,
    quoteAsset: 'USD',
    assetClass: 'CRYPTO',
    enabled: true,
    pricePrecision: 2,
    quantityPrecision: 8,
    schedule: '24/7',
    iconKey: baseAsset.toLowerCase(),
    accent,
    maxLeverage,
    sortOrder,
    providerSymbols: {
      kraken: `${baseAsset}/USD`,
      coinbase: `${baseAsset}-USD`,
      pythFeedEnvironmentKey: `PYTH_FEED_ID_${baseAsset}_USD`,
    },
  };
};

/**
 * Product-wide source of truth for supported markets, risk caps, display metadata, and
 * upstream symbol mappings. Keep this list curated; arbitrary ticker entry is unsupported.
 */
export const MARKET_REGISTRY: Readonly<Record<MarketSymbol, CanonicalMarketMetadata>> = {
  'BTC-USD': market('BTC-USD', 'Bitcoin', 5, 10, '#f7931a'),
  'ETH-USD': market('ETH-USD', 'Ethereum', 5, 20, '#8b9cff'),
  'SOL-USD': market('SOL-USD', 'Solana', 4, 30, '#66e6c1'),
  'XRP-USD': market('XRP-USD', 'XRP', 3, 40, '#d8e1e8'),
  'DOGE-USD': market('DOGE-USD', 'Dogecoin', 3, 50, '#c9a633'),
  'LINK-USD': market('LINK-USD', 'Chainlink', 3, 60, '#4c6fff'),
  'AVAX-USD': market('AVAX-USD', 'Avalanche', 3, 70, '#e84142'),
  'ADA-USD': market('ADA-USD', 'Cardano', 2, 80, '#3b8edb'),
  'SUI-USD': market('SUI-USD', 'Sui', 2, 90, '#6fbcf0'),
  'AAVE-USD': market('AAVE-USD', 'Aave', 2, 100, '#8a75d6'),
  'NEAR-USD': market('NEAR-USD', 'NEAR Protocol', 2, 110, '#b9f3dc'),
  'LTC-USD': market('LTC-USD', 'Litecoin', 3, 120, '#b7bcc7'),
};

export function isMarketSymbol(value: string): value is MarketSymbol {
  return (SUPPORTED_MARKET_SYMBOLS as readonly string[]).includes(value);
}

export function allowedLeverages(symbol: MarketSymbol): Leverage[] {
  const maximum = MARKET_REGISTRY[symbol].maxLeverage;
  return ([1, 2, 3, 4, 5] as const).filter((value) => value <= maximum);
}
