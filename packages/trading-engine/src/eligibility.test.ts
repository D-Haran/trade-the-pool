import { describe, expect, it } from 'vitest';
import { assertEntryEligibility, DomainError } from './index.js';
import { parseMoney } from '@trade-the-pool/shared';
const base = {
  status: 'OPEN' as const,
  entryClosesAt: new Date('2030-01-01'),
  maxEntriesPerUser: 3,
  entryCount: 0,
  pool: parseMoney('50000.00'),
  contribution: parseMoney('25.00'),
  userExists: true,
};
describe('entry eligibility', () => {
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
