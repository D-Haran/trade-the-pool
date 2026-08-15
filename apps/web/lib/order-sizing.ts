function cents(value: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid money amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function positionSizeFromMargin(margin: string, leverage: number): string {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error('Invalid leverage');
  return money(cents(margin) * BigInt(leverage));
}

export function marginFromPositionSize(positionSize: string, leverage: number): string {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error('Invalid leverage');
  const notional = cents(positionSize);
  return money((notional + BigInt(leverage) - 1n) / BigInt(leverage));
}
