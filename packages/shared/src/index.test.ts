import { describe, expect, it } from 'vitest';
import { addMoney, moneyToString, parseMoney, subtractMoney } from './index.js';

describe('money', () => {
  it('uses exact cents without binary floating point', () => {
    const amount = parseMoney('50000.00');
    expect(moneyToString(addMoney(amount, parseMoney('25.00')))).toBe('50025.00');
    expect(moneyToString(subtractMoney(amount, parseMoney('0.01')))).toBe('49999.99');
  });
  it('rejects more than two decimal places', () => expect(() => parseMoney('1.001')).toThrow());
});
