import { MARKET_REGISTRY, type MarketSymbolDto } from '@trade-the-pool/shared';

function decimalParts(value: string): { negative: boolean; whole: string; fraction: string } {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawWhole = '0', fraction = ''] = unsigned.split('.');
  return { negative, whole: rawWhole.replace(/^0+(?=\d)/, ''), fraction };
}

function roundedParts(value: string, digits: number) {
  const parsed = decimalParts(value);
  const scale = 10n ** BigInt(digits);
  const padded = parsed.fraction.padEnd(digits + 1, '0');
  let scaled = BigInt(parsed.whole) * scale + BigInt(padded.slice(0, digits) || '0');
  if (Number(padded[digits] ?? '0') >= 5) scaled += 1n;
  return {
    negative: parsed.negative,
    whole: (scaled / scale).toString(),
    fraction: digits ? (scaled % scale).toString().padStart(digits, '0') : '',
  };
}

function grouped(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatUsd(value: string, options: { signed?: boolean } = {}): string {
  const { negative, whole, fraction } = decimalParts(value);
  const sign = negative ? '-' : options.signed && value !== '0' && value !== '0.00' ? '+' : '';
  return `${sign}$${grouped(whole)}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export function formatPercent(value: string, signed = true): string {
  const { negative, whole, fraction } = decimalParts(value);
  const isZero = /^0*$/.test(whole) && /^0*$/.test(fraction);
  const sign = negative ? '-' : signed && !isZero ? '+' : '';
  return `${sign}${grouped(whole)}.${fraction.padEnd(2, '0').slice(0, 2)}%`;
}

export function formatBasisPoints(value: string | null | undefined, signed = true): string {
  if (value == null) return '—';
  const basisPoints = BigInt(value);
  const negative = basisPoints < 0n;
  const absolute = negative ? -basisPoints : basisPoints;
  const sign = negative ? '-' : signed && absolute > 0n ? '+' : '';
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}%`;
}

export function formatMultiple(numerator: string, denominator: string): string {
  const top = BigInt(numerator.replace('.', ''));
  const bottom = BigInt(denominator.replace('.', ''));
  if (bottom <= 0n) return '—';
  const hundredths = (top * 100n + bottom / 2n) / bottom;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}x`;
}

export function formatPrice(value: string, symbol?: MarketSymbolDto): string {
  const raw = decimalParts(value);
  const digits = symbol
    ? MARKET_REGISTRY[symbol].pricePrecision
    : BigInt(raw.whole) >= 1_000n
      ? 2
      : BigInt(raw.whole) >= 1n
        ? 4
        : 6;
  const { negative, whole, fraction } = roundedParts(value, digits);
  return `${negative ? '-' : ''}$${grouped(whole)}${digits ? `.${fraction}` : ''}`;
}

export function formatQuantity(
  value: string,
  precisionOrSymbol: number | MarketSymbolDto = 8,
): string {
  const maximum =
    typeof precisionOrSymbol === 'number'
      ? precisionOrSymbol
      : MARKET_REGISTRY[precisionOrSymbol].quantityPrecision;
  const { negative, whole, fraction } = roundedParts(value, maximum);
  const trimmed = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped(whole)}${trimmed ? `.${trimmed}` : ''}`;
}

function compactDecimal(value: string): { value: string; suffix: string } | null {
  const parsed = decimalParts(value);
  const scale = 100_000_000n;
  const exact =
    BigInt(parsed.whole) * scale + BigInt(parsed.fraction.padEnd(8, '0').slice(0, 8) || '0');
  const units = [
    { threshold: 1_000_000_000n, suffix: 'B' },
    { threshold: 1_000_000n, suffix: 'M' },
    { threshold: 1_000n, suffix: 'K' },
  ];
  const unit = units.find(({ threshold }) => exact >= threshold * scale);
  if (!unit) return null;
  const tenths = (exact * 10n + (unit.threshold * scale) / 2n) / (unit.threshold * scale);
  return {
    value: `${parsed.negative ? '-' : ''}${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ''}`,
    suffix: unit.suffix,
  };
}

export function formatCompactQuantity(value: string, symbol?: MarketSymbolDto): string {
  const compact = compactDecimal(value);
  const asset = symbol ? ` ${MARKET_REGISTRY[symbol].baseAsset}` : '';
  return compact
    ? `${compact.value}${compact.suffix}${asset}`
    : `${formatQuantity(value, symbol ?? 4)}${asset}`;
}

export function formatBaseVolume(value: string, symbol: MarketSymbolDto): string {
  return formatCompactQuantity(value, symbol);
}

export function formatCompactUsd(value: string): string {
  const { whole } = decimalParts(value);
  const amount = BigInt(whole);
  const units = [
    { threshold: 1_000_000_000n, suffix: 'B' },
    { threshold: 1_000_000n, suffix: 'M' },
    { threshold: 1_000n, suffix: 'K' },
  ];
  const unit = units.find(({ threshold }) => amount >= threshold);
  if (!unit) return formatUsd(value);
  const tenths = (amount * 10n) / unit.threshold;
  return `$${tenths / 10n}${tenths % 10n === 0n ? '' : `.${tenths % 10n}`}${unit.suffix}`;
}

export function formatDate(value: string | null): string {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function isPositive(value: string): boolean {
  return !value.startsWith('-') && value !== '0' && value !== '0.00';
}
