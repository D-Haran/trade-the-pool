import { describe, expect, it } from 'vitest';
import { assertEntryEligibility, calculateNewEntryBankroll, DomainError } from './index.js';
import { parseMoney } from '@trade-the-pool/shared';
const base = {
  status: 'OPEN' as const,
  entryClosesAt: new Date('2030-01-01'),
  maxEntriesPerUser: 3,
  entryCount: 0,
  baseBankroll: parseMoney('10000.00'),
  currentPrizePool: parseMoney('500.00'),
  contribution: parseMoney('25.00'),
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
    ['status', 'DRAFT'],
    ['entryCount', 3],
  ] as const)
    it(`rejects ${key}`, () =>
      expect(() =>
        assertEntryEligibility({ ...base, [key]: value } as typeof base, new Date('2029-01-01')),
      ).toThrow(DomainError));
});
