import { describe, expect, it } from 'vitest';
import { parsePrice, parseQuantity } from '@trade-the-pool/shared';
import {
  createLiveMarketDataService,
  DEFAULT_MAXIMUM_JUMP_BASIS_POINTS,
  LiveMarketDataService,
} from './live-service.js';
import type { UpstreamEvent, UpstreamMarketDataAdapter } from './providers.js';
import type {
  MarketCandle,
  MarketPriceSnapshot,
  MarketSymbol,
  ProviderHealth,
  SubMinuteCandleStore,
} from './types.js';

class Adapter implements UpstreamMarketDataAdapter {
  readonly listeners = new Set<(event: UpstreamEvent) => void>();
  candleRequests = 0;
  failCandles = false;
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
    if (this.failCandles) throw new Error('provider unavailable');
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

  it('preserves the last trusted ETH mark and suppresses execution callbacks for a malformed scale jump', () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService({ primary, comparison, authoritative });
    const executable: MarketPriceSnapshot[] = [];
    let rejected = 0;
    service.subscribe((snapshot) => executable.push(snapshot));
    service.subscribeMarketEvents((event) => {
      if (event.type === 'mark-rejected') rejected += 1;
    });
    service.start();
    primary.emit({ type: 'price', role: 'PRIMARY_EXCHANGE', snapshot: quote('ETH-USD', '1880') });
    comparison.emit({ type: 'price', role: 'COMPARISON', snapshot: quote('ETH-USD', '1881') });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('ETH-USD', '1880'),
    });
    expect(executable).toHaveLength(1);

    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('ETH-USD', '188000'),
    });
    expect(executable).toHaveLength(1);
    expect(service.getMarketView('ETH-USD')).toMatchObject({
      status: 'DEGRADED',
      authoritativeMark: { price: parsePrice('1880') },
    });
    expect(rejected).toBe(1);

    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('ETH-USD', '1881'),
    });
    expect(executable).toHaveLength(2);
    expect(service.getSnapshot('ETH-USD')).toMatchObject({
      price: parsePrice('1881'),
      status: 'LIVE',
      executionEligible: true,
    });
    void service.close();
  });

  it('rejects an unsupported one-tick jump when comparisons are unavailable without cross-wiring symbols', () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService({ primary, comparison, authoritative });
    service.start();
    primary.emit({ type: 'price', role: 'PRIMARY_EXCHANGE', snapshot: quote('ETH-USD', '2000') });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('ETH-USD', '2000'),
    });
    primary.emit({
      type: 'price',
      role: 'PRIMARY_EXCHANGE',
      snapshot: quote('BTC-USD', '100000'),
    });
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('BTC-USD', '100000'),
    });
    const future = new Date(Date.now() + 30_000);
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: {
        ...quote('ETH-USD', '20000', future),
        receivedAt: future,
      },
    });
    expect(service.getMarketView('ETH-USD')).toMatchObject({
      status: 'DEGRADED',
      authoritativeMark: { symbol: 'ETH-USD', price: parsePrice('2000') },
    });
    expect(service.getSnapshot('BTC-USD')).toMatchObject({
      symbol: 'BTC-USD',
      price: parsePrice('100000'),
    });
    void service.close();
  });

  it('pauses rather than trusting a cold-start mark with no independent price', () => {
    const primary = new Adapter('primary');
    const comparison = new Adapter('comparison');
    const authoritative = new Adapter('authority');
    const service = new LiveMarketDataService({ primary, comparison, authoritative });
    let rejectionReason: string | null = null;
    service.subscribeMarketEvents((event) => {
      if (event.type === 'mark-rejected') rejectionReason = event.reason;
    });
    service.start();
    authoritative.emit({
      type: 'price',
      role: 'AUTHORITATIVE',
      snapshot: quote('ETH-USD', '188000'),
    });
    expect(service.getMarketView('ETH-USD')).toMatchObject({
      status: 'UNAVAILABLE',
      authoritativeMark: null,
    });
    expect(rejectionReason).toBe('UNVERIFIED_INITIAL_MARK');
    expect(() => service.getSnapshot('ETH-USD')).toThrow();
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
        maximumJumpBasisPoints: DEFAULT_MAXIMUM_JUMP_BASIS_POINTS,
        futureTimestampToleranceMs: 2_000,
      },
    );
    service.start();
    primary.emit({
      type: 'price',
      role: 'PRIMARY_EXCHANGE',
      snapshot: quote('BTC-USD', '100000'),
    });
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
        maximumJumpBasisPoints: DEFAULT_MAXIMUM_JUMP_BASIS_POINTS,
        futureTimestampToleranceMs: 2_000,
      },
    );
    service.start();
    primary.emit({
      type: 'price',
      role: 'PRIMARY_EXCHANGE',
      snapshot: quote('SOL-USD', '200', new Date(Date.now() - 100)),
    });
    comparison.emit({
      type: 'price',
      role: 'COMPARISON',
      snapshot: quote('SOL-USD', '200'),
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

  it('serves sub-minute history from genuine normalized trades without calling Kraken OHLC', async () => {
    const primary = new Adapter('primary');
    const service = new LiveMarketDataService({
      primary,
      comparison: new Adapter('comparison'),
      authoritative: new Adapter('authority'),
    });
    service.start();
    const tradeTimestamp = new Date();
    const bucket = new Date(Math.floor(tradeTimestamp.getTime() / 1_000) * 1_000);
    primary.emit({
      type: 'trades',
      symbol: 'BTC-USD',
      trades: [
        {
          id: 'trade-1',
          symbol: 'BTC-USD',
          price: parsePrice('100'),
          quantity: parseQuantity('0.25'),
          side: 'BUY',
          timestamp: tradeTimestamp,
          venue: 'Kraken',
        },
      ],
    });
    const candles = await service.getCandles('BTC-USD', '1s', 100);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({
      timestamp: bucket,
      close: parsePrice('100'),
      volume: parseQuantity('0.25'),
    });
    expect(primary.candleRequests).toBe(0);
    expect(service.getHealth().components.subMinuteCandles).toBe('primary:matched-trades');
    expect(service.getHealth().subMinute[0]).toMatchObject({
      symbol: 'BTC-USD',
      bufferSizes: { '1s': 1, '5s': 1, '15s': 1, '30s': 1 },
    });
    await service.close();
  });

  it('loads 600 recent bars, paginates older bars in order, and reuses the cached provider range', async () => {
    const primary = new Adapter('primary');
    primary.getCandles = async () => {
      primary.candleRequests += 1;
      return Array.from({ length: 720 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)),
        open: parsePrice(String(100 + index)),
        high: parsePrice(String(100 + index)),
        low: parsePrice(String(100 + index)),
        close: parsePrice(String(100 + index)),
        volume: null,
      }));
    };
    const service = new LiveMarketDataService({
      primary,
      comparison: new Adapter('comparison'),
      authoritative: new Adapter('authority'),
    });
    const latest = await service.getCandles('BTC-USD', '1m', { limit: 600 });
    const older = await service.getCandles('BTC-USD', '1m', {
      limit: 600,
      before: latest[0].timestamp,
    });
    expect(latest).toHaveLength(600);
    expect(older).toHaveLength(120);
    expect(older.at(-1)!.timestamp < latest[0].timestamp).toBe(true);
    expect(primary.candleRequests).toBe(1);
  });

  it('does not cache failed history requests and allows a clean retry', async () => {
    const primary = new Adapter('primary');
    primary.failCandles = true;
    const service = new LiveMarketDataService({
      primary,
      comparison: new Adapter('comparison'),
      authoritative: new Adapter('authority'),
    });
    await expect(service.getCandles('BTC-USD', '5m', { limit: 600 })).rejects.toThrow(
      'provider unavailable',
    );
    primary.failCandles = false;
    await expect(service.getCandles('BTC-USD', '5m', { limit: 600 })).resolves.toHaveLength(1);
    expect(primary.candleRequests).toBe(2);
  });

  it('reconciles durable sub-minute history with in-memory bars after restart', async () => {
    const storedCandle: MarketCandle = {
      timestamp: new Date('2026-01-01T00:00:00Z'),
      open: parsePrice('100'),
      high: parsePrice('101'),
      low: parsePrice('99'),
      close: parsePrice('100'),
      volume: parseQuantity('2'),
    };
    const store: SubMinuteCandleStore = {
      async load(symbol, interval, request) {
        return symbol === 'BTC-USD' && interval === '5s' && !request.before ? [storedCandle] : [];
      },
      async persist() {},
    };
    const service = new LiveMarketDataService(
      {
        primary: new Adapter('primary'),
        comparison: new Adapter('comparison'),
        authoritative: new Adapter('authority'),
      },
      undefined,
      { subMinuteStore: store },
    );
    await service.start();
    const restored = await service.getCandles('BTC-USD', '5s', { limit: 600 });
    expect(restored).toEqual([storedCandle]);
    await service.close();
  });
});
