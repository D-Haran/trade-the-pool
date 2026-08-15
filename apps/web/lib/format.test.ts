import { describe, expect, it } from 'vitest';
import {
  formatBaseVolume,
  formatCompactQuantity,
  formatCompactUsd,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatUsd,
} from './format';

describe('financial display formatting', () => {
  it('preserves exact cents and explicit signs without accounting arithmetic', () => {
    expect(formatUsd('82410.00')).toBe('$82,410.00');
    expect(formatUsd('8618.42', { signed: true })).toBe('+$8,618.42');
    expect(formatUsd('-420.00', { signed: true })).toBe('-$420.00');
    expect(formatPercent('-3.27')).toBe('-3.27%');
  });

  it('uses stable market precision and compact pool labels', () => {
    expect(formatPrice('100000.12345678')).toBe('$100,000.12');
    expect(formatPrice('0.12345678')).toBe('$0.123457');
    expect(formatQuantity('24.81600000')).toBe('24.816');
    expect(formatCompactUsd('82410.00')).toBe('$82.4K');
  });

  it('uses centralized market-aware price, quantity, and volume precision', () => {
    expect(formatPrice('63008.5149', 'BTC-USD')).toBe('$63,008.51');
    expect(formatPrice('75.49', 'SOL-USD')).toBe('$75.4900');
    expect(formatPrice('0.0701094', 'DOGE-USD')).toBe('$0.070109');
    expect(formatQuantity('46.10519000', 'SOL-USD')).toBe('46.1052');
    expect(formatCompactQuantity('149629.12794912', 'SOL-USD')).toBe('149.6K SOL');
    expect(formatBaseVolume('11250000.00000000', 'BTC-USD')).toBe('11.3M BTC');
  });
});
