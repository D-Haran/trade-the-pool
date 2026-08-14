import { describe, expect, it } from 'vitest';
import { moneyToString, parseMoney } from '@trade-the-pool/shared';
import {
  applicableEntryFeeTier,
  calculateRakeback,
  projectPayouts,
  validateEntryFeeTiers,
  type EntryFeeTier,
} from './economics.js';

const tiers: EntryFeeTier[] = [
  {
    ordinal: 0,
    minPrizePool: parseMoney('0.00'),
    maxPrizePool: parseMoney('5000.00'),
    entryFee: parseMoney('15.00'),
    prizePoolContribution: parseMoney('12.00'),
    platformFee: parseMoney('3.00'),
    futureRewardAllocation: parseMoney('0.00'),
  },
  {
    ordinal: 1,
    minPrizePool: parseMoney('5000.00'),
    maxPrizePool: null,
    entryFee: parseMoney('20.00'),
    prizePoolContribution: parseMoney('16.00'),
    platformFee: parseMoney('4.00'),
    futureRewardAllocation: parseMoney('0.00'),
  },
];

describe('tournament economics', () => {
  it('maps inclusive-lower/exclusive-upper fee boundaries deterministically', () => {
    expect(moneyToString(applicableEntryFeeTier(tiers, parseMoney('4999.99')).entryFee)).toBe(
      '15.00',
    );
    expect(moneyToString(applicableEntryFeeTier(tiers, parseMoney('5000.00')).entryFee)).toBe(
      '20.00',
    );
  });

  it('rejects fee-tier gaps and allocation mismatches', () => {
    expect(() =>
      validateEntryFeeTiers([tiers[0], { ...tiers[1], minPrizePool: parseMoney('5000.01') }]),
    ).toThrow('contiguous');
    expect(() =>
      validateEntryFeeTiers([{ ...tiers[0], maxPrizePool: null, entryFee: parseMoney('99.00') }]),
    ).toThrow('allocations');
  });

  it('projects exact payouts and never allocates above the pool', () => {
    const projection = projectPayouts(
      parseMoney('12480.00'),
      {
        directPrizes: [
          { position: 1, basisPoints: 4000 },
          { position: 2, basisPoints: 2000 },
          { position: 3, basisPoints: 1000 },
        ],
        additionalCashLine: { percentileBasisPoints: 1000, allocationBasisPoints: 3000 },
      },
      100,
    );
    expect(moneyToString(projection.firstPrize)).toBe('4992.00');
    expect(moneyToString(projection.secondPrize)).toBe('2496.00');
    expect(moneyToString(projection.thirdPrize)).toBe('1248.00');
    expect(projection.cashLinePosition).toBe(10);
    expect(projection.allocatedAmount).toBeLessThanOrEqual(projection.distributableAmount);

    const undersubscribed = projectPayouts(
      parseMoney('100.00'),
      {
        directPrizes: [
          { position: 1, basisPoints: 5000 },
          { position: 2, basisPoints: 3000 },
          { position: 3, basisPoints: 2000 },
        ],
      },
      1,
    );
    expect(undersubscribed.paidEntries).toBe(1);
    expect(undersubscribed.paidEntriesPercentBasisPoints).toBe(10_000);
  });

  it('takes rakeback only from platform allocation', () => {
    expect(
      moneyToString(
        calculateRakeback(parseMoney('4.00'), 2, {
          bands: [{ entryCount: 10, rebateBasisPoints: 5000 }],
        }),
      ),
    ).toBe('2.00');
  });
});
