import {
  addMoney,
  applyBasisPoints,
  moneyFromMinorUnits,
  type Money,
} from '@trade-the-pool/shared';
import { DomainError } from './errors.js';

export type EntryFeeTier = {
  ordinal: number;
  minPrizePool: Money;
  maxPrizePool: Money | null;
  entryFee: Money;
  prizePoolContribution: Money;
  platformFee: Money;
  futureRewardAllocation: Money;
};

export type PayoutConfig = {
  directPrizes: Array<{ position: number; basisPoints: number }>;
  additionalCashLine?: {
    percentileBasisPoints: number;
    allocationBasisPoints: number;
  };
};

export type RakebackConfig = {
  bands: Array<{ entryCount: number; rebateBasisPoints: number }>;
};

export type ProjectedPayout = { position: number; amount: Money; basisPoints: number | null };
export type PayoutProjection = {
  prizes: ProjectedPayout[];
  firstPrize: Money;
  secondPrize: Money;
  thirdPrize: Money;
  cashLinePosition: number;
  paidEntries: number;
  paidEntriesPercentBasisPoints: number;
  distributableAmount: Money;
  allocatedAmount: Money;
  unallocatedAmount: Money;
};

export function calculateNewEntryBankroll(baseBankroll: Money, currentPrizePool: Money): Money {
  return addMoney(baseBankroll, currentPrizePool);
}

export function validateEntryFeeTiers(tiers: readonly EntryFeeTier[]): void {
  if (tiers.length === 0)
    throw new DomainError('INVALID_FEE_TIERS', 'At least one entry fee tier is required');
  const ordered = [...tiers].sort((left, right) => left.ordinal - right.ordinal);
  let expectedMinimum = moneyFromMinorUnits(0n);
  for (let index = 0; index < ordered.length; index += 1) {
    const tier = ordered[index];
    if (tier.ordinal !== index)
      throw new DomainError('INVALID_FEE_TIERS', 'Fee tier ordinals must be contiguous from zero');
    if (tier.minPrizePool !== expectedMinimum)
      throw new DomainError('INVALID_FEE_TIERS', 'Fee tier thresholds must be contiguous');
    if (
      tier.entryFee < 0n ||
      tier.prizePoolContribution < 0n ||
      tier.platformFee < 0n ||
      tier.futureRewardAllocation < 0n ||
      tier.entryFee !== tier.prizePoolContribution + tier.platformFee + tier.futureRewardAllocation
    )
      throw new DomainError(
        'INVALID_FEE_TIERS',
        'Each entry fee must equal its configured allocations',
      );
    const final = index === ordered.length - 1;
    if (final && tier.maxPrizePool !== null)
      throw new DomainError('INVALID_FEE_TIERS', 'The final fee tier must be unbounded');
    if (!final && (tier.maxPrizePool === null || tier.maxPrizePool <= tier.minPrizePool))
      throw new DomainError('INVALID_FEE_TIERS', 'Non-final fee tiers need an increasing maximum');
    if (tier.maxPrizePool !== null) expectedMinimum = tier.maxPrizePool;
  }
}

export function applicableEntryFeeTier(
  tiers: readonly EntryFeeTier[],
  currentPrizePool: Money,
): EntryFeeTier {
  if (currentPrizePool < 0n)
    throw new DomainError('INVALID_POOL', 'Current prize pool cannot be negative');
  validateEntryFeeTiers(tiers);
  const matches = tiers.filter(
    (tier) =>
      currentPrizePool >= tier.minPrizePool &&
      (tier.maxPrizePool === null || currentPrizePool < tier.maxPrizePool),
  );
  if (matches.length !== 1)
    throw new DomainError(
      'INVALID_FEE_TIERS',
      'Current prize pool must map to exactly one entry fee tier',
    );
  return matches[0];
}

export function nextEntryFeeTier(
  tiers: readonly EntryFeeTier[],
  currentTier: EntryFeeTier,
): EntryFeeTier | null {
  return tiers.find((tier) => tier.ordinal === currentTier.ordinal + 1) ?? null;
}

export function validatePayoutConfig(config: PayoutConfig): void {
  if (config.directPrizes.length === 0)
    throw new DomainError('INVALID_PAYOUT_CONFIG', 'At least one direct prize is required');
  const positions = new Set<number>();
  let totalBasisPoints = 0;
  for (const prize of config.directPrizes) {
    if (
      !Number.isInteger(prize.position) ||
      prize.position <= 0 ||
      !Number.isInteger(prize.basisPoints) ||
      prize.basisPoints < 0 ||
      prize.basisPoints > 10_000 ||
      positions.has(prize.position)
    )
      throw new DomainError('INVALID_PAYOUT_CONFIG', 'Direct payout positions are invalid');
    positions.add(prize.position);
    totalBasisPoints += prize.basisPoints;
  }
  if (config.additionalCashLine) {
    const additional = config.additionalCashLine;
    if (
      !Number.isInteger(additional.percentileBasisPoints) ||
      additional.percentileBasisPoints <= 0 ||
      additional.percentileBasisPoints > 10_000 ||
      !Number.isInteger(additional.allocationBasisPoints) ||
      additional.allocationBasisPoints < 0 ||
      additional.allocationBasisPoints > 10_000
    )
      throw new DomainError('INVALID_PAYOUT_CONFIG', 'Additional cash-line payout is invalid');
    totalBasisPoints += additional.allocationBasisPoints;
  }
  if (totalBasisPoints > 10_000)
    throw new DomainError(
      'INVALID_PAYOUT_CONFIG',
      'Payout allocations cannot exceed the distributable prize pool',
    );
}

function percentOfEntries(totalEntries: number, basisPoints: number): number {
  if (totalEntries <= 0) return 0;
  return Math.ceil((totalEntries * basisPoints) / 10_000);
}

export function projectPayouts(
  prizePool: Money,
  config: PayoutConfig,
  totalEntries: number,
): PayoutProjection {
  if (prizePool < 0n || !Number.isInteger(totalEntries) || totalEntries < 0)
    throw new DomainError('INVALID_PAYOUT_CONFIG', 'Payout projection input is invalid');
  validatePayoutConfig(config);
  const direct = [...config.directPrizes].sort((left, right) => left.position - right.position);
  const highestDirectPosition = direct.at(-1)?.position ?? 0;
  const percentilePaid = config.additionalCashLine
    ? percentOfEntries(totalEntries, config.additionalCashLine.percentileBasisPoints)
    : 0;
  const paidEntries = Math.min(totalEntries, Math.max(highestDirectPosition, percentilePaid));
  const prizes: ProjectedPayout[] = direct.map((prize) => ({
    position: prize.position,
    amount: applyBasisPoints(prizePool, BigInt(prize.basisPoints)),
    basisPoints: prize.basisPoints,
  }));
  if (config.additionalCashLine) {
    const additionalPositions = Math.max(0, paidEntries - highestDirectPosition);
    if (additionalPositions > 0) {
      const bucket = applyBasisPoints(
        prizePool,
        BigInt(config.additionalCashLine.allocationBasisPoints),
      );
      const amountEach = bucket / BigInt(additionalPositions);
      let remainder = bucket % BigInt(additionalPositions);
      for (let index = 0; index < additionalPositions; index += 1) {
        const extra = remainder > 0n ? 1n : 0n;
        if (remainder > 0n) remainder -= 1n;
        prizes.push({
          position: highestDirectPosition + index + 1,
          amount: moneyFromMinorUnits(amountEach + extra),
          basisPoints: null,
        });
      }
    }
  }
  const allocatedAmount = moneyFromMinorUnits(
    prizes.reduce((total, prize) => total + prize.amount, 0n),
  );
  const amountAt = (position: number) =>
    prizes.find((prize) => prize.position === position)?.amount ?? moneyFromMinorUnits(0n);
  return {
    prizes,
    firstPrize: amountAt(1),
    secondPrize: amountAt(2),
    thirdPrize: amountAt(3),
    cashLinePosition: paidEntries,
    paidEntries,
    paidEntriesPercentBasisPoints:
      totalEntries === 0 ? 0 : Math.round((paidEntries * 10_000) / totalEntries),
    distributableAmount: prizePool,
    allocatedAmount,
    unallocatedAmount: moneyFromMinorUnits(prizePool - allocatedAmount),
  };
}

export function calculateRakeback(
  platformAllocation: Money,
  tournamentEntryNumber: number,
  config: RakebackConfig | null,
): Money {
  if (!config) return moneyFromMinorUnits(0n);
  if (!Number.isInteger(tournamentEntryNumber) || tournamentEntryNumber <= 0)
    throw new DomainError('INVALID_RAKEBACK_CONFIG', 'Tournament entry number must be positive');
  let upperBound = 0;
  for (const band of config.bands) {
    if (
      !Number.isInteger(band.entryCount) ||
      band.entryCount <= 0 ||
      !Number.isInteger(band.rebateBasisPoints) ||
      band.rebateBasisPoints < 0 ||
      band.rebateBasisPoints > 10_000
    )
      throw new DomainError('INVALID_RAKEBACK_CONFIG', 'Rakeback bands are invalid');
    upperBound += band.entryCount;
    if (tournamentEntryNumber <= upperBound)
      return applyBasisPoints(platformAllocation, BigInt(band.rebateBasisPoints));
  }
  return moneyFromMinorUnits(0n);
}
