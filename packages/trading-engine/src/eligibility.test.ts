import { describe, expect, it } from 'vitest';
import { assertEntryEligibility, calculateNewEntryBankroll, DomainError } from './index.js';
import { parseMoney } from '@trade-the-pool/shared';
const base = {
  status: 'TRADING_ACTIVE' as const,
  schedule: {
    registrationOpensAt: new Date('2028-01-01'),
    tradingStartsAt: new Date('2028-06-01'),
    entryClosesAt: new Date('2030-01-01'),
    tradingClosesAt: new Date('2030-01-02'),
  },
  maxEntriesPerUser: 3,
  entryCount: 0,
  baseBankroll: parseMoney('10000.00'),
  currentPrizePool: parseMoney('500.00'),
  userExists: true,
};
describe('entry eligibility', () => {
  it('derives the new-entry bankroll from base plus the current prize pool exactly', () => {
    expect(calculateNewEntryBankroll(parseMoney('10000.00'), parseMoney('500.00'))).toBe(
      parseMoney('10500.00'),
    );
  });
  it('accepts a valid entry', () =>
    expect(() => assertEntryEligibility(base, new Date('2029-01-01'))).not.toThrow());
  for (const [key, value] of [
    ['userExists', false],
    ['status', 'CANCELLED'],
    ['entryCount', 3],
  ] as const)
    it(`rejects ${key}`, () =>
      expect(() =>
        assertEntryEligibility({ ...base, [key]: value } as typeof base, new Date('2029-01-01')),
      ).toThrow(DomainError));
});
