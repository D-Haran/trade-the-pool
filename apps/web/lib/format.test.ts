import { describe, expect, it } from 'vitest';
import { formatCompactUsd, formatPercent, formatPrice, formatQuantity, formatUsd } from './format';

describe('financial display formatting', () => {
  it('preserves exact cents and explicit signs without accounting arithmetic', () => {
    expect(formatUsd('82410.00')).toBe('$82,410.00');
    expect(formatUsd('8618.42', { signed: true })).toBe('+$8,618.42');
    expect(formatUsd('-420.00', { signed: true })).toBe('-$420.00');
    expect(formatPercent('-3.27')).toBe('-3.27%');
  });

  it('uses stable market precision and compact pool labels', () => {
    expect(formatPrice('100000.12345678')).toBe('$100,000.12');
    expect(formatPrice('0.12345678')).toBe('$0.123456');
    expect(formatQuantity('24.81600000')).toBe('24.816');
    expect(formatCompactUsd('82410.00')).toBe('$82.4K');
  });
});
