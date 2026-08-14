function decimalParts(value: string): { negative: boolean; whole: string; fraction: string } {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawWhole = '0', fraction = ''] = unsigned.split('.');
  return { negative, whole: rawWhole.replace(/^0+(?=\d)/, ''), fraction };
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

export function formatPrice(value: string): string {
  const { whole, fraction } = decimalParts(value);
  const digits = BigInt(whole) >= 1_000n ? 2 : BigInt(whole) >= 1n ? 4 : 6;
  return `$${grouped(whole)}.${fraction.padEnd(digits, '0').slice(0, digits)}`;
}

export function formatQuantity(value: string, maximum = 8): string {
  const { negative, whole, fraction } = decimalParts(value);
  const trimmed = fraction.slice(0, maximum).replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped(whole)}${trimmed ? `.${trimmed}` : ''}`;
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
