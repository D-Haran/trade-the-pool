import { parsePrice, parseQuantity, type Price, type Quantity } from '@trade-the-pool/shared';
import type { MarketOrderBook, MarketSymbol, OrderBookLevel } from './types.js';

export type RawBookLevel = { price: string; qty: string };
export type KrakenBookPayload = {
  symbol: MarketSymbol;
  bids: RawBookLevel[];
  asks: RawBookLevel[];
  checksum: number;
  timestamp: Date;
};

function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index);
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumPart(value: string): string {
  return value.replace('.', '').replace(/^0+/, '') || '0';
}

export function krakenBookChecksum(
  asks: readonly RawBookLevel[],
  bids: readonly RawBookLevel[],
): number {
  const compare = (left: RawBookLevel, right: RawBookLevel): number => {
    const leftPrice = parsePrice(left.price);
    const rightPrice = parsePrice(right.price);
    return leftPrice === rightPrice ? 0 : leftPrice < rightPrice ? -1 : 1;
  };
  const input = [...asks]
    .sort(compare)
    .slice(0, 10)
    .concat([...bids].sort((left, right) => compare(right, left)).slice(0, 10))
    .map((level) => checksumPart(level.price) + checksumPart(level.qty))
    .join('');
  return crc32(input);
}

function rawLevels(levels: ReadonlyMap<string, string>, descending: boolean): RawBookLevel[] {
  return [...levels]
    .map(([price, qty]) => ({ price, qty }))
    .sort((left, right) => {
      const leftPrice = parsePrice(left.price);
      const rightPrice = parsePrice(right.price);
      if (leftPrice === rightPrice) return 0;
      return descending ? (leftPrice > rightPrice ? -1 : 1) : leftPrice < rightPrice ? -1 : 1;
    });
}

function exactLevels(levels: RawBookLevel[], depth: number): OrderBookLevel[] {
  let cumulative = 0n;
  return levels.slice(0, depth).map((level) => {
    const quantity = parseQuantity(level.qty);
    cumulative += quantity;
    return { price: parsePrice(level.price), quantity, total: cumulative as Quantity };
  });
}

/** Maintains one Kraken venue book from a snapshot followed by ordered deltas. */
export class KrakenOrderBook {
  readonly #bids = new Map<string, string>();
  readonly #asks = new Map<string, string>();
  #timestamp: Date | null = null;
  #synchronized = false;

  constructor(
    readonly symbol: MarketSymbol,
    readonly depth = 25,
  ) {}

  clear(): void {
    this.#bids.clear();
    this.#asks.clear();
    this.#timestamp = null;
    this.#synchronized = false;
  }

  applySnapshot(payload: KrakenBookPayload): boolean {
    this.clear();
    for (const level of payload.bids) this.#set(this.#bids, level);
    for (const level of payload.asks) this.#set(this.#asks, level);
    this.#truncate();
    this.#timestamp = new Date(payload.timestamp);
    this.#synchronized = this.#validate(payload.checksum);
    if (!this.#synchronized) this.clear();
    return this.#synchronized;
  }

  applyUpdate(payload: KrakenBookPayload): boolean {
    if (!this.#synchronized) return false;
    for (const level of payload.bids) this.#set(this.#bids, level);
    for (const level of payload.asks) this.#set(this.#asks, level);
    this.#truncate();
    this.#timestamp = new Date(payload.timestamp);
    this.#synchronized = this.#validate(payload.checksum);
    if (!this.#synchronized) this.clear();
    return this.#synchronized;
  }

  snapshot(requestedDepth = this.depth): MarketOrderBook {
    const depth = Math.max(1, Math.min(this.depth, requestedDepth));
    const bids = exactLevels(rawLevels(this.#bids, true), depth);
    const asks = exactLevels(rawLevels(this.#asks, false), depth);
    const spread =
      bids[0] && asks[0] && asks[0].price >= bids[0].price
        ? ((asks[0].price - bids[0].price) as Price)
        : null;
    const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2n : null;
    return {
      symbol: this.symbol,
      venue: 'Kraken',
      status: this.#synchronized ? 'LIVE' : 'RECONNECTING',
      timestamp: this.#timestamp ? new Date(this.#timestamp) : null,
      bids,
      asks,
      spread,
      spreadBasisPoints: spread !== null && mid && mid > 0n ? (spread * 10_000n) / mid : null,
    };
  }

  #set(side: Map<string, string>, level: RawBookLevel): void {
    parsePrice(level.price);
    const quantity = parseQuantity(level.qty);
    if (quantity === 0n) side.delete(level.price);
    else side.set(level.price, level.qty);
  }

  #truncate(): void {
    for (const level of rawLevels(this.#bids, true).slice(this.depth))
      this.#bids.delete(level.price);
    for (const level of rawLevels(this.#asks, false).slice(this.depth))
      this.#asks.delete(level.price);
  }

  #validate(expected: number): boolean {
    return (
      krakenBookChecksum(rawLevels(this.#asks, false), rawLevels(this.#bids, true)) ===
      expected >>> 0
    );
  }
}
