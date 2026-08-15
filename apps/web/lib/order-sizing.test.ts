import { describe, expect, it } from 'vitest';
import { marginFromPositionSize, positionSizeFromMargin } from './order-sizing';

describe('order sizing contract', () => {
  it('converts margin into the single authoritative position notional', () => {
    expect(positionSizeFromMargin('1000.00', 5)).toBe('5000.00');
  });

  it('converts position size into conservatively rounded required margin', () => {
    expect(marginFromPositionSize('5000.00', 5)).toBe('1000.00');
    expect(marginFromPositionSize('1000.01', 3)).toBe('333.34');
  });
});
