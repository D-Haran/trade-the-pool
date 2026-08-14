import { describe, expect, it } from 'vitest';
import { parsePrice } from '@trade-the-pool/shared';
import { createLiveMarketDataService, LiveMarketDataService } from './live-service.js';
import type { UpstreamEvent, UpstreamMarketDataAdapter } from './providers.js';
import type { MarketCandle, MarketPriceSnapshot, MarketSymbol, ProviderHealth } from './types.js';

class Adapter implements UpstreamMarketDataAdapter {
  readonly listeners = new Set<(event: UpstreamEvent) => void>();
  candleRequests = 0;
  constructor(readonly name: string) {}
  start() {}
  close() {}
  subscribe(listener: (event: UpstreamEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: UpstreamEvent) {
    for (const listener of this.listeners) listener(event);
  }
  getHealth(): ProviderHealth {
    return {
      provider: this.name,
      connection: 'CONNECTED',
      lastMessageAt: new Date(),
      lastValidPriceAt: new Date(),
      lastBookUpdateAt: null,
      lastTradeAt: null,
      reconnectCount: 0,
      orderBookResyncCount: 0,
      lastError: null,
    };
  }
  async getCandles() {
    this.candleRequests += 1;
    const candle = (timestamp: string, close: string): MarketCandle => ({
      timestamp: new Date(timestamp),
      open: parsePrice(close),
      high: parsePrice(close),
      low: parsePrice(close),
      close: parsePrice(close),
      volume: null,
    });
    return [candle('2026-01-01T00:00:00Z', '100.00'), candle('2026-01-01T00:00:00Z', '101.00')];
  }
}

function quote(symbol: MarketSymbol, price: string, timestamp = new Date()): MarketPriceSnapshot {
  return {
    symbol,
    price: parsePrice(price),
    marketTimestamp: timestamp,
    receivedAt: new Date(),
    source: 'test',
  };
}

describe('LiveMarketDataService', () => {
  it('fails live construction when authority configuration is missing', () => {
    expect(() =>
      createLiveMarketDataService({
        mode: 'live',
        krakenWsUrl: 'wss://kraken.invalid',
        krakenRestUrl: 'https://kraken.invalid',
        coinbaseWsUrl: 'wss://coinbase.invalid',
        pythHermesUrl: 'https://pyth.invalid',
      }),
    ).toThrow('requires a Pyth API key');
  });

  it('allows fresh validated authority, blocks abnormal deviation, and recovers', () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService({ primary, comparison, authoritative });
    service.start();
    expect(service.getMarketView('BTC-USD').status).toBe('UNAVAILABLE');
    primary.emit({ type: 'price', role: 'PRIMARY_EXCHANGE', snapshot: quote('BTC-USD', '100000') });
    comparison.emit({ type: 'price', role: 'COMPARISON', snapshot: quote('BTC-USD', '100050') });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('BTC-USD', '100000'),
    });
    expect(service.getSnapshot('BTC-USD')).toMatchObject({
      executionEligible: true,
      status: 'LIVE',
    });
    comparison.emit({ type: 'price', role: 'COMPARISON', snapshot: quote('BTC-USD', '105000') });
    expect(service.getSnapshot('BTC-USD')).toMatchObject({
      executionEligible: false,
      status: 'DEGRADED',
    });
    comparison.emit({ type: 'price', role: 'COMPARISON', snapshot: quote('BTC-USD', '100010') });
    expect(service.getSnapshot('BTC-USD').executionEligible).toBe(true);
    void service.close();
  });

  it('marks old authority stale and deduplicates/reconciles candle history requests', async () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService(
      { primary, comparison, authoritative },
      {
        authoritativeDelayedMs: 10,
        authoritativeStaleMs: 20,
        exchangeDelayedMs: 10,
        exchangeStaleMs: 20,
        bookStaleMs: 20,
        comparisonStaleMs: 20,
        maximumDeviationBasisPoints: 100n,
        futureTimestampToleranceMs: 2_000,
      },
    );
    service.start();
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('BTC-USD', '100000', new Date(Date.now() - 100)),
    });
    expect(service.getSnapshot('BTC-USD')).toMatchObject({
      status: 'STALE',
      executionEligible: false,
    });
    const [left, right] = await Promise.all([
      service.getCandles('BTC-USD', '5m', 100),
      service.getCandles('BTC-USD', '5m', 100),
    ]);
    expect(primary.candleRequests).toBe(1);
    expect(left).toHaveLength(1);
    expect(left[0].close).toBe(parsePrice('101.00'));
    expect(right).toEqual(left);
    const replacement: MarketCandle = {
      timestamp: new Date('2026-01-01T00:00:00Z'),
      open: parsePrice('100.00'),
      high: parsePrice('103.00'),
      low: parsePrice('99.00'),
      close: parsePrice('102.00'),
      volume: null,
    };
    primary.emit({
      type: 'candle',
      symbol: 'BTC-USD',
      interval: '5m',
      candle: replacement,
    });
    primary.emit({
      type: 'candle',
      symbol: 'BTC-USD',
      interval: '5m',
      candle: { ...replacement, timestamp: new Date('2026-01-01T00:05:00Z') },
    });
    const reconciled = await service.getCandles('BTC-USD', '5m', 100);
    expect(reconciled).toHaveLength(2);
    expect(reconciled[0]).toMatchObject({
      high: parsePrice('103.00'),
      low: parsePrice('99.00'),
      close: parsePrice('102.00'),
    });
    expect(reconciled[1].timestamp.toISOString()).toBe('2026-01-01T00:05:00.000Z');
    expect(service.getHealth()).toMatchObject({
      mode: 'live',
      components: {
        currentPrice: 'primary',
        historicalCandles: 'primary:rest-ohlc',
        orderBook: 'primary',
        recentTrades: 'primary',
        authoritativeMark: 'authority',
        comparisonPrice: 'comparison',
      },
    });
    await service.close();
  });

  it('tracks exchange freshness independently and rejects future authority timestamps', () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService(
      { primary, comparison, authoritative },
      {
        authoritativeDelayedMs: 5_000,
        authoritativeStaleMs: 20_000,
        exchangeDelayedMs: 10,
        exchangeStaleMs: 20,
        bookStaleMs: 20,
        comparisonStaleMs: 20,
        maximumDeviationBasisPoints: 100n,
        futureTimestampToleranceMs: 2_000,
      },
    );
    service.start();
    primary.emit({
      type: 'price',
      role: 'PRIMARY_EXCHANGE',
      snapshot: quote('SOL-USD', '200', new Date(Date.now() - 100)),
    });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('SOL-USD', '200'),
    });
    expect(service.getMarketView('SOL-USD')).toMatchObject({
      status: 'LIVE',
      exchangeStatus: 'STALE',
    });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('BTC-USD', '100000', new Date(Date.now() + 10_000)),
    });
    expect(() => service.getSnapshot('BTC-USD')).toThrow('unavailable');
    void service.close();
  });
});
