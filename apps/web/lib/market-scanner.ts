import type { MarketSnapshotDto } from '@trade-the-pool/shared';

export type ScannerSignal = {
  symbol: MarketSnapshotDto['symbol'];
  label: string;
  detail: string;
  direction: 'positive' | 'negative' | 'neutral';
};

const magnitude = (value: string | null) => {
  if (value === null) return -1n;
  const exact = BigInt(value);
  return exact < 0n ? -exact : exact;
};

function scaledPrice(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

export function rangeBasisPoints(market: MarketSnapshotDto): bigint | null {
  if (!market.high24h || !market.low24h) return null;
  const price = scaledPrice(market.price);
  if (price <= 0n) return null;
  return ((scaledPrice(market.high24h) - scaledPrice(market.low24h)) * 10_000n) / price;
}

function percent(value: bigint): string {
  const sign = value > 0n ? '+' : value < 0n ? '−' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}%`;
}

/** Objective scanner derived only from server-provided 24-hour market statistics. */
export function scanMarkets(markets: MarketSnapshotDto[]): ScannerSignal[] {
  const available = markets.filter((market) => market.change24hBasisPoints !== null);
  if (!available.length) return [];
  const mover = [...available].sort((left, right) =>
    Number(magnitude(right.change24hBasisPoints) - magnitude(left.change24hBasisPoints)),
  )[0];
  const rangeLeader = [...available]
    .map((market) => ({ market, range: rangeBasisPoints(market) }))
    .filter((item): item is { market: MarketSnapshotDto; range: bigint } => item.range !== null)
    .sort((left, right) => Number(right.range - left.range))[0];
  const positiveLeader = [...available]
    .filter((market) => BigInt(market.change24hBasisPoints!) > 0n)
    .sort((left, right) =>
      Number(BigInt(right.change24hBasisPoints!) - BigInt(left.change24hBasisPoints!)),
    )[0];
  const signals: ScannerSignal[] = [];
  if (mover) {
    const move = BigInt(mover.change24hBasisPoints!);
    signals.push({
      symbol: mover.symbol,
      label: 'Largest 24h move',
      detail: percent(move),
      direction: move < 0n ? 'negative' : move > 0n ? 'positive' : 'neutral',
    });
  }
  if (rangeLeader && rangeLeader.market.symbol !== mover?.symbol)
    signals.push({
      symbol: rangeLeader.market.symbol,
      label: 'Widest 24h range',
      detail: percent(rangeLeader.range),
      direction: 'neutral',
    });
  if (positiveLeader && !signals.some((signal) => signal.symbol === positiveLeader.symbol))
    signals.push({
      symbol: positiveLeader.symbol,
      label: '24h upside leader',
      detail: percent(BigInt(positiveLeader.change24hBasisPoints!)),
      direction: 'positive',
    });
  return signals.slice(0, 3);
}
