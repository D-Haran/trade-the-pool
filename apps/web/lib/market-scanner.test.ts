import { describe, expect, it } from 'vitest';
import type { MarketSnapshotDto } from '@trade-the-pool/shared';
import { rangeBasisPoints, scanMarkets } from './market-scanner';

function market(
  symbol: MarketSnapshotDto['symbol'],
  change24hBasisPoints: string,
  high24h: string,
  low24h: string,
): MarketSnapshotDto {
  return {
    symbol,
    dataMode: 'fake',
    price: '100.00000000',
    markPrice: '100.00000000',
    marketTimestamp: '2026-01-01T00:00:00.000Z',
    markTimestamp: '2026-01-01T00:00:00.000Z',
    source: 'test',
    markSource: 'test',
    status: 'LIVE',
    exchangeStatus: 'LIVE',
    availability: 'ACTIVE',
    deviationBasisPoints: '0',
    change24hBasisPoints,
    high24h,
    low24h,
    volume24h: null,
    provenance: {
      currentPrice: 'test',
      statistics24h: 'test',
      historicalCandles: 'test',
      realtimeCandles: 'test',
      orderBook: 'test',
      recentTrades: 'test',
      authoritativeMark: 'test',
      comparisonPrice: 'test',
    },
    metadata: {
      assetClass: 'CRYPTO',
      displayName: symbol,
      baseCurrency: symbol.split('-')[0],
      quoteCurrency: 'USD',
      tradingSchedule: '24/7',
      pricePrecision: 2,
      quantityPrecision: 8,
      iconKey: 'test',
      accent: '#fff',
      maxLeverage: 2,
      sortOrder: 1,
    },
  };
}

describe('market activity scanner', () => {
  it('uses only supplied objective change and range statistics', () => {
    const btc = market('BTC-USD', '125', '102.00', '98.00');
    const sui = market('SUI-USD', '-320', '110.00', '90.00');
    expect(rangeBasisPoints(sui)).toBe(2_000n);
    const signals = scanMarkets([btc, sui]);
    expect(signals[0]).toMatchObject({ symbol: 'SUI-USD', detail: '−3.20%' });
    expect(signals.some((signal) => signal.label === 'Widest 24h range')).toBe(false);
    expect(signals.some((signal) => signal.symbol === 'BTC-USD')).toBe(true);
  });
});
