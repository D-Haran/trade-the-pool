import WebSocket from 'ws';
import { decimalToString, parsePrice, parseQuantity, type Price } from '@trade-the-pool/shared';
import { INTERVAL_MS } from './deterministic.js';
import { KrakenOrderBook, type KrakenBookPayload, type RawBookLevel } from './order-book.js';
import {
  MARKET_METADATA,
  SUPPORTED_SYMBOLS,
  canonicalSymbol,
  type CandleInterval,
  type MarketCandle,
  type MarketOrderBook,
  type MarketPriceSnapshot,
  type MarketStatistics,
  type MarketSymbol,
  type MarketTrade,
  type ProviderConnectionState,
  type ProviderHealth,
} from './types.js';

export type UpstreamRole = 'PRIMARY_EXCHANGE' | 'COMPARISON' | 'AUTHORITATIVE';
export type UpstreamEvent =
  | {
      type: 'price';
      role: UpstreamRole;
      snapshot: MarketPriceSnapshot;
      statistics?: MarketStatistics;
    }
  | { type: 'book'; book: MarketOrderBook }
  | { type: 'trades'; symbol: MarketSymbol; trades: MarketTrade[] }
  | { type: 'candle'; symbol: MarketSymbol; interval: CandleInterval; candle: MarketCandle }
  | { type: 'health'; health: ProviderHealth };

export interface UpstreamMarketDataAdapter {
  readonly name: string;
  start(): Promise<void> | void;
  close(): Promise<void> | void;
  subscribe(listener: (event: UpstreamEvent) => void): () => void;
  getHealth(): ProviderHealth;
  getCandles?(
    symbol: MarketSymbol,
    interval: CandleInterval,
    limit: number,
  ): Promise<MarketCandle[]>;
}

export function boundedBackoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  return base + Math.floor(random() * Math.min(2_000, Math.max(1, base / 2)));
}

/** Quotes JSON decimal tokens before parsing so price and quantity lexemes remain exact strings. */
export function parseJsonPreservingDecimals(raw: string): unknown {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < raw.length) {
    const character = raw[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === '-' || (character >= '0' && character <= '9')) {
      let end = index + 1;
      while (end < raw.length && /[0-9.eE+-]/.test(raw[end])) end += 1;
      const token = raw.slice(index, end);
      output += token.includes('.') || /[eE]/.test(token) ? JSON.stringify(token) : token;
      index = end;
      continue;
    }
    output += character;
    index += 1;
  }
  return JSON.parse(output);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== null) : [];
}

function validDate(value: unknown): Date | null {
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function percentToBasisPoints(value: unknown): bigint | null {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const rounded = BigInt(whole) * 100n + BigInt(fraction.padEnd(3, '0').slice(0, 2));
  return negative ? -rounded : rounded;
}

function baseHealth(provider: string): ProviderHealth {
  return {
    provider,
    connection: 'DISCONNECTED',
    lastMessageAt: null,
    lastValidPriceAt: null,
    lastBookUpdateAt: null,
    lastTradeAt: null,
    reconnectCount: 0,
    orderBookResyncCount: 0,
    lastError: null,
  };
}

abstract class ReconnectingAdapter implements UpstreamMarketDataAdapter {
  abstract readonly name: string;
  protected readonly listeners = new Set<(event: UpstreamEvent) => void>();
  protected health!: ProviderHealth;
  protected socket: WebSocket | null = null;
  #stopped = true;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;

  protected abstract get url(): string;
  protected abstract onOpen(socket: WebSocket): void;
  protected abstract onMessage(raw: string): void;

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.connect();
  }

  close(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.socket?.close(1000, 'Service shutdown');
    this.socket = null;
    this.setConnection('DISCONNECTED');
  }

  subscribe(listener: (event: UpstreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getHealth(): ProviderHealth {
    return { ...this.health };
  }

  protected emit(event: UpstreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  protected touchMessage(): void {
    this.health.lastMessageAt = new Date();
  }

  protected setConnection(connection: ProviderConnectionState, error: string | null = null): void {
    this.health.connection = connection;
    this.health.lastError = error;
    this.emit({ type: 'health', health: this.getHealth() });
  }

  private connect(): void {
    this.setConnection(this.#attempt ? 'RECONNECTING' : 'CONNECTING');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.#attempt = 0;
      this.setConnection('CONNECTED');
      this.onOpen(socket);
    });
    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      this.touchMessage();
      try {
        this.onMessage(data.toString());
      } catch (error) {
        this.health.lastError = error instanceof Error ? error.message : 'Malformed upstream data';
        this.emit({ type: 'health', health: this.getHealth() });
      }
    });
    socket.on('error', (error) => {
      this.health.lastError = error.message;
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.#stopped) return;
      this.health.reconnectCount += 1;
      this.setConnection('RECONNECTING', this.health.lastError);
      const delay = boundedBackoffMs(this.#attempt++);
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.connect();
      }, delay);
      this.#timer.unref();
    });
  }
}

const KRAKEN_INTERVALS: Record<CandleInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

export type KrakenAdapterOptions = { wsUrl: string; restUrl: string; depth?: 10 | 25 };

export class KrakenMarketDataAdapter extends ReconnectingAdapter {
  readonly name = 'kraken-ws-v2';
  protected health = baseHealth(this.name);
  readonly #books: Map<MarketSymbol, KrakenOrderBook>;
  private readonly options: KrakenAdapterOptions;

  constructor(options: KrakenAdapterOptions) {
    super();
    this.options = options;
    this.#books = new Map(
      SUPPORTED_SYMBOLS.map((symbol) => [
        symbol,
        new KrakenOrderBook(symbol, this.options.depth ?? 25),
      ]),
    );
  }

  protected get url(): string {
    return this.options.wsUrl;
  }

  protected onOpen(socket: WebSocket): void {
    const symbols = SUPPORTED_SYMBOLS.map(
      (symbol) => MARKET_METADATA[symbol].providerSymbols.kraken,
    );
    for (const params of [
      { channel: 'ticker', symbol: symbols, event_trigger: 'trades', snapshot: true },
      { channel: 'trade', symbol: symbols, snapshot: true },
      { channel: 'book', symbol: symbols, depth: this.options.depth ?? 25, snapshot: true },
    ])
      socket.send(JSON.stringify({ method: 'subscribe', params }));
    // Kraken accepts only one OHLC interval subscription per symbol. Other chart intervals
    // bootstrap from REST and advance from the genuine ticker stream in the client.
    socket.send(
      JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'ohlc',
          symbol: symbols,
          interval: KRAKEN_INTERVALS['1m'],
          snapshot: true,
        },
      }),
    );
  }

  protected onMessage(raw: string): void {
    const message = record(parseJsonPreservingDecimals(raw));
    if (!message) return;
    if (message.method === 'subscribe' && message.success === false)
      throw new Error(String(message.error ?? 'Kraken subscription failed'));
    const channel = String(message.channel ?? '');
    if (channel === 'ticker') this.onTicker(message);
    else if (channel === 'trade') this.onTrades(message);
    else if (channel === 'book') this.onBook(message);
    else if (channel === 'ohlc') this.onCandle(message);
  }

  private onTicker(message: Record<string, unknown>): void {
    for (const item of records(message.data)) {
      const symbol = canonicalSymbol('kraken', String(item.symbol));
      const timestamp = validDate(item.timestamp);
      if (!symbol || !timestamp) continue;
      const snapshot: MarketPriceSnapshot = {
        symbol,
        price: parsePrice(String(item.last)),
        marketTimestamp: timestamp,
        receivedAt: new Date(),
        source: this.name,
      };
      this.health.lastValidPriceAt = new Date();
      this.emit({
        type: 'price',
        role: 'PRIMARY_EXCHANGE',
        snapshot,
        statistics: {
          change24hBasisPoints: percentToBasisPoints(item.change_pct),
          high24h: item.high == null ? null : parsePrice(String(item.high)),
          low24h: item.low == null ? null : parsePrice(String(item.low)),
          volume24h: item.volume == null ? null : parseQuantity(String(item.volume)),
        },
      });
    }
  }

  private onTrades(message: Record<string, unknown>): void {
    const bySymbol = new Map<MarketSymbol, MarketTrade[]>();
    for (const item of records(message.data)) {
      const symbol = canonicalSymbol('kraken', String(item.symbol));
      const timestamp = validDate(item.timestamp);
      if (!symbol || !timestamp) continue;
      const trade: MarketTrade = {
        id: String(item.trade_id),
        symbol,
        price: parsePrice(String(item.price)),
        quantity: parseQuantity(String(item.qty)),
        side: item.side === 'buy' ? 'BUY' : item.side === 'sell' ? 'SELL' : null,
        timestamp,
        venue: 'Kraken',
      };
      bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), trade]);
    }
    for (const [symbol, trades] of bySymbol) {
      this.health.lastTradeAt = new Date();
      this.emit({ type: 'trades', symbol, trades });
    }
  }

  private onBook(message: Record<string, unknown>): void {
    for (const item of records(message.data)) {
      const symbol = canonicalSymbol('kraken', String(item.symbol));
      const timestamp = validDate(item.timestamp);
      const checksum = Number(item.checksum);
      if (!symbol || !timestamp || !Number.isInteger(checksum)) continue;
      const level = (value: Record<string, unknown>): RawBookLevel => ({
        price: String(value.price),
        qty: String(value.qty),
      });
      const payload: KrakenBookPayload = {
        symbol,
        bids: records(item.bids).map(level),
        asks: records(item.asks).map(level),
        checksum,
        timestamp,
      };
      const book = this.#books.get(symbol)!;
      const valid =
        message.type === 'snapshot' ? book.applySnapshot(payload) : book.applyUpdate(payload);
      if (!valid) {
        this.health.orderBookResyncCount += 1;
        this.emit({ type: 'book', book: book.snapshot() });
        this.resubscribeBook(symbol);
        return;
      }
      this.health.lastBookUpdateAt = new Date();
      this.emit({ type: 'book', book: book.snapshot() });
    }
  }

  private resubscribeBook(symbol: MarketSymbol): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const venueSymbol = MARKET_METADATA[symbol].providerSymbols.kraken;
    this.socket.send(
      JSON.stringify({
        method: 'unsubscribe',
        params: { channel: 'book', symbol: [venueSymbol], depth: this.options.depth ?? 25 },
      }),
    );
    this.socket.send(
      JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'book',
          symbol: [venueSymbol],
          depth: this.options.depth ?? 25,
          snapshot: true,
        },
      }),
    );
  }

  private onCandle(message: Record<string, unknown>): void {
    for (const item of records(message.data)) {
      const symbol = canonicalSymbol('kraken', String(item.symbol));
      const timestamp = validDate(item.interval_begin);
      const interval = Object.entries(KRAKEN_INTERVALS).find(
        ([, minutes]) => minutes === Number(item.interval),
      )?.[0] as CandleInterval | undefined;
      if (!symbol || !timestamp || !interval) continue;
      this.emit({
        type: 'candle',
        symbol,
        interval,
        candle: {
          timestamp,
          open: parsePrice(String(item.open)),
          high: parsePrice(String(item.high)),
          low: parsePrice(String(item.low)),
          close: parsePrice(String(item.close)),
          volume: item.volume == null ? null : parseQuantity(String(item.volume)),
        },
      });
    }
  }

  async getCandles(
    symbol: MarketSymbol,
    interval: CandleInterval,
    limit: number,
  ): Promise<MarketCandle[]> {
    const pair = encodeURIComponent(MARKET_METADATA[symbol].providerSymbols.kraken);
    const response = await fetch(
      `${this.options.restUrl.replace(/\/$/, '')}/0/public/OHLC?pair=${pair}&interval=${KRAKEN_INTERVALS[interval]}`,
      { headers: { accept: 'application/json', 'user-agent': 'trade-the-pool-market-data/1.0' } },
    );
    if (!response.ok) throw new Error(`Kraken OHLC request failed with ${response.status}`);
    const body = record(parseJsonPreservingDecimals(await response.text()));
    const errors = Array.isArray(body?.error) ? body.error : [];
    if (!body || errors.length) throw new Error(`Kraken OHLC error: ${errors.join(', ')}`);
    const result = record(body.result);
    const rows = Object.entries(result ?? {}).find(
      ([key, value]) => key !== 'last' && Array.isArray(value),
    )?.[1];
    if (!Array.isArray(rows)) throw new Error('Kraken OHLC response did not contain candles');
    return rows
      .map((row): MarketCandle | null => {
        if (!Array.isArray(row) || row.length < 7) return null;
        const timestamp = new Date(Number(row[0]) * 1_000);
        if (!Number.isFinite(timestamp.getTime())) return null;
        return {
          timestamp,
          open: parsePrice(String(row[1])),
          high: parsePrice(String(row[2])),
          low: parsePrice(String(row[3])),
          close: parsePrice(String(row[4])),
          volume: parseQuantity(String(row[6])),
        };
      })
      .filter((candle): candle is MarketCandle => candle !== null)
      .sort((left, right) => +left.timestamp - +right.timestamp)
      .slice(-limit);
  }
}

export class CoinbaseMarketDataAdapter extends ReconnectingAdapter {
  readonly name = 'coinbase-advanced-trade';
  protected health = baseHealth(this.name);

  constructor(private readonly wsUrl: string) {
    super();
  }

  protected get url(): string {
    return this.wsUrl;
  }

  protected onOpen(socket: WebSocket): void {
    const productIds = SUPPORTED_SYMBOLS.map(
      (symbol) => MARKET_METADATA[symbol].providerSymbols.coinbase,
    );
    socket.send(JSON.stringify({ type: 'subscribe', product_ids: productIds, channel: 'ticker' }));
    socket.send(
      JSON.stringify({ type: 'subscribe', product_ids: productIds, channel: 'heartbeats' }),
    );
  }

  protected onMessage(raw: string): void {
    const message = record(JSON.parse(raw));
    if (!message || message.channel !== 'ticker') return;
    const timestamp = validDate(message.timestamp) ?? new Date();
    for (const event of records(message.events))
      for (const ticker of records(event.tickers)) {
        const symbol = canonicalSymbol('coinbase', String(ticker.product_id));
        if (!symbol) continue;
        const snapshot: MarketPriceSnapshot = {
          symbol,
          price: parsePrice(String(ticker.price)),
          marketTimestamp: timestamp,
          receivedAt: new Date(),
          source: this.name,
        };
        this.health.lastValidPriceAt = new Date();
        this.emit({ type: 'price', role: 'COMPARISON', snapshot });
      }
  }
}

export type PythAdapterOptions = {
  hermesUrl: string;
  apiKey: string;
  feedIds: Record<MarketSymbol, string>;
};

export function pythIntegerToPrice(value: string, exponent: number): Price {
  if (!/^-?\d+$/.test(value) || !Number.isInteger(exponent)) throw new Error('Invalid Pyth price');
  const integer = BigInt(value);
  if (integer <= 0n) throw new Error('Pyth price must be positive');
  const scaleExponent = exponent + 8;
  let scaled: bigint;
  if (scaleExponent >= 0) scaled = integer * 10n ** BigInt(scaleExponent);
  else {
    const divisor = 10n ** BigInt(-scaleExponent);
    scaled = (integer + divisor / 2n) / divisor;
  }
  return parsePrice(decimalToString(scaled));
}

export function parsePythUpdates(
  payload: unknown,
  feedIds: Partial<Record<MarketSymbol, string>>,
  receivedAt = new Date(),
): MarketPriceSnapshot[] {
  const inverse = new Map(
    Object.entries(feedIds).flatMap(([symbol, id]) =>
      id ? [[id.replace(/^0x/, '').toLowerCase(), symbol] as const] : [],
    ),
  );
  const parsed = records(record(payload)?.parsed);
  return parsed.flatMap((item) => {
    try {
      const symbol = inverse.get(String(item.id).replace(/^0x/, '').toLowerCase()) as
        MarketSymbol | undefined;
      const price = record(item.price);
      const timestamp = new Date(Number(price?.publish_time) * 1_000);
      const exponent = Number(price?.expo);
      const confidence = String(price?.conf);
      if (
        !symbol ||
        !price ||
        !Number.isInteger(exponent) ||
        !/^-?\d+$/.test(confidence) ||
        !Number.isFinite(timestamp.getTime())
      )
        return [];
      return [
        {
          symbol,
          price: pythIntegerToPrice(String(price.price), exponent),
          ...(BigInt(confidence) > 0n
            ? { confidence: pythIntegerToPrice(confidence, exponent) }
            : {}),
          marketTimestamp: timestamp,
          receivedAt: new Date(receivedAt),
          source: 'pyth-hermes',
        },
      ];
    } catch {
      return [];
    }
  });
}

export class PythHermesAdapter implements UpstreamMarketDataAdapter {
  readonly name = 'pyth-hermes';
  readonly #listeners = new Set<(event: UpstreamEvent) => void>();
  #health = baseHealth(this.name);
  readonly #controllers = new Map<MarketSymbol, AbortController>();
  readonly #attempts = new Map<MarketSymbol, number>();
  readonly #timers = new Map<MarketSymbol, NodeJS.Timeout>();
  readonly #connected = new Set<MarketSymbol>();
  readonly #errors = new Map<MarketSymbol, string>();
  #stopped = true;

  constructor(private readonly options: PythAdapterOptions) {}

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    for (const symbol of SUPPORTED_SYMBOLS) void this.connect(symbol);
  }

  close(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#connected.clear();
    this.#errors.clear();
    this.setConnection('DISCONNECTED');
  }

  subscribe(listener: (event: UpstreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getHealth(): ProviderHealth {
    return { ...this.#health };
  }

  private emit(event: UpstreamEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  private setConnection(connection: ProviderConnectionState, error: string | null = null): void {
    this.#health.connection = connection;
    this.#health.lastError = error;
    this.emit({ type: 'health', health: this.getHealth() });
  }

  private refreshConnection(): void {
    const errors = [...this.#errors.entries()]
      .map(([symbol, error]) => `${symbol}: ${error}`)
      .join('; ');
    this.setConnection(
      this.#connected.size ? 'CONNECTED' : this.#attempts.size ? 'RECONNECTING' : 'CONNECTING',
      errors || null,
    );
  }

  private async connect(symbol: MarketSymbol): Promise<void> {
    this.refreshConnection();
    const controller = new AbortController();
    this.#controllers.set(symbol, controller);
    const query = `ids[]=${encodeURIComponent(this.options.feedIds[symbol])}`;
    try {
      const response = await fetch(
        `${this.options.hermesUrl.replace(/\/$/, '')}/v2/updates/price/stream?parsed=true&${query}`,
        {
          headers: {
            accept: 'text/event-stream',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(
          response.status === 403
            ? 'Pyth Hermes stream is not entitled for this symbol'
            : `Pyth Hermes stream failed with ${response.status}`,
        );
      }
      this.#attempts.set(symbol, 0);
      this.#errors.delete(symbol);
      this.#connected.add(symbol);
      this.refreshConnection();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.#stopped) {
        const result = await reader.read();
        if (result.done) break;
        buffer = `${buffer}${decoder.decode(result.value, { stream: true })}`.replace(
          /\r\n/g,
          '\n',
        );
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (data) {
            const receivedAt = new Date();
            this.#health.lastMessageAt = receivedAt;
            for (const snapshot of parsePythUpdates(JSON.parse(data), {
              [symbol]: this.options.feedIds[symbol],
            }, receivedAt)) {
              this.#health.lastValidPriceAt = receivedAt;
              this.emit({ type: 'price', role: 'AUTHORITATIVE', snapshot });
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!this.#stopped) throw new Error('Pyth Hermes stream ended');
    } catch (error) {
      if (this.#stopped || (error instanceof Error && error.name === 'AbortError')) return;
      this.#connected.delete(symbol);
      this.#health.reconnectCount += 1;
      this.#errors.set(
        symbol,
        error instanceof Error ? error.message : 'Pyth Hermes connection failed',
      );
      this.refreshConnection();
      const attempt = this.#attempts.get(symbol) ?? 0;
      this.#attempts.set(symbol, attempt + 1);
      const delay = boundedBackoffMs(attempt);
      const timer = setTimeout(() => {
        this.#timers.delete(symbol);
        void this.connect(symbol);
      }, delay);
      this.#timers.set(symbol, timer);
      timer.unref();
    } finally {
      if (this.#controllers.get(symbol) === controller) this.#controllers.delete(symbol);
    }
  }
}

export function candleBucket(timestamp: Date, interval: CandleInterval): Date {
  return new Date(Math.floor(timestamp.getTime() / INTERVAL_MS[interval]) * INTERVAL_MS[interval]);
}
