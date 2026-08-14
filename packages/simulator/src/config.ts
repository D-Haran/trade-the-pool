import { parseMoney } from '@trade-the-pool/shared';
import type { EntryFeeTier } from '@trade-the-pool/trading-engine';
import type { SimulationConfig, TraderArchetype, TraderArchetypeName } from './types.js';

export const TRADER_ARCHETYPES: Record<TraderArchetypeName, TraderArchetype> = {
  RANDOM: {
    name: 'RANDOM',
    skill: 0,
    riskTolerance: 0.45,
    entryTimePreference: 0,
    reentryPropensity: 0.1,
    tradeFrequency: 0.45,
    positionConcentrationBasisPoints: 3500,
    directionalAccuracy: 0.5,
    holdingPeriodSteps: 8,
  },
  WEAK: {
    name: 'WEAK',
    skill: -0.12,
    riskTolerance: 0.45,
    entryTimePreference: -0.1,
    reentryPropensity: 0.12,
    tradeFrequency: 0.65,
    positionConcentrationBasisPoints: 4000,
    directionalAccuracy: 0.46,
    holdingPeriodSteps: 7,
  },
  AVERAGE: {
    name: 'AVERAGE',
    skill: 0.05,
    riskTolerance: 0.4,
    entryTimePreference: 0,
    reentryPropensity: 0.12,
    tradeFrequency: 0.5,
    positionConcentrationBasisPoints: 3500,
    directionalAccuracy: 0.53,
    holdingPeriodSteps: 9,
  },
  SKILLED: {
    name: 'SKILLED',
    skill: 0.32,
    riskTolerance: 0.45,
    entryTimePreference: -0.05,
    reentryPropensity: 0.16,
    tradeFrequency: 0.55,
    positionConcentrationBasisPoints: 4000,
    directionalAccuracy: 0.62,
    holdingPeriodSteps: 10,
  },
  HIGH_RISK: {
    name: 'HIGH_RISK',
    skill: 0.02,
    riskTolerance: 0.95,
    entryTimePreference: 0.1,
    reentryPropensity: 0.22,
    tradeFrequency: 0.7,
    positionConcentrationBasisPoints: 9500,
    directionalAccuracy: 0.51,
    holdingPeriodSteps: 12,
  },
  LATE_ENTRY_OPTIMIZER: {
    name: 'LATE_ENTRY_OPTIMIZER',
    skill: 0.12,
    riskTolerance: 0.5,
    entryTimePreference: 0.85,
    reentryPropensity: 0.14,
    tradeFrequency: 0.55,
    positionConcentrationBasisPoints: 5000,
    directionalAccuracy: 0.56,
    holdingPeriodSteps: 6,
  },
  EARLY_ENTRY_OPTIMIZER: {
    name: 'EARLY_ENTRY_OPTIMIZER',
    skill: 0.12,
    riskTolerance: 0.42,
    entryTimePreference: -0.85,
    reentryPropensity: 0.1,
    tradeFrequency: 0.6,
    positionConcentrationBasisPoints: 4000,
    directionalAccuracy: 0.56,
    holdingPeriodSteps: 10,
  },
  REENTRY_OPTIMIZER: {
    name: 'REENTRY_OPTIMIZER',
    skill: 0.14,
    riskTolerance: 0.55,
    entryTimePreference: 0.15,
    reentryPropensity: 0.72,
    tradeFrequency: 0.55,
    positionConcentrationBasisPoints: 5000,
    directionalAccuracy: 0.57,
    holdingPeriodSteps: 8,
  },
};

const defaultWeights: Record<TraderArchetypeName, number> = {
  RANDOM: 18,
  WEAK: 14,
  AVERAGE: 26,
  SKILLED: 12,
  HIGH_RISK: 10,
  LATE_ENTRY_OPTIMIZER: 7,
  EARLY_ENTRY_OPTIMIZER: 7,
  REENTRY_OPTIMIZER: 6,
};

function tiers(values: Array<[string, string | null, string, string, string]>): EntryFeeTier[] {
  return values.map(([minimum, maximum, fee, contribution, platform], ordinal) => ({
    ordinal,
    minPrizePool: parseMoney(minimum),
    maxPrizePool: maximum === null ? null : parseMoney(maximum),
    entryFee: parseMoney(fee),
    prizePoolContribution: parseMoney(contribution),
    platformFee: parseMoney(platform),
    futureRewardAllocation: parseMoney('0.00'),
  }));
}

const common = {
  players: 120,
  steps: 96,
  tradingStartsFraction: 0.1,
  entryClosesFraction: 0.85,
  maxEntriesPerUser: 3,
  feeTiers: tiers([
    ['0.00', '2500.00', '10.00', '8.00', '2.00'],
    ['2500.00', '5000.00', '15.00', '12.00', '3.00'],
    ['5000.00', '10000.00', '20.00', '16.00', '4.00'],
    ['10000.00', '25000.00', '25.00', '20.00', '5.00'],
    ['25000.00', null, '35.00', '28.00', '7.00'],
  ]),
  payoutConfig: {
    directPrizes: [
      { position: 1, basisPoints: 4000 },
      { position: 2, basisPoints: 2000 },
      { position: 3, basisPoints: 1000 },
    ],
    additionalCashLine: { percentileBasisPoints: 1000, allocationBasisPoints: 3000 },
  },
  rakebackConfig: null,
  tradingFeeBasisPoints: 10,
  positionLimitBasisPoints: 10_000,
  arrivalModel: 'POOL_SIZE_SENSITIVE' as const,
  networkEffect: {
    enabled: true,
    prizePoolSensitivity: 0.18,
    participantSensitivity: 0.12,
    conclusionSensitivity: 0.08,
  },
  priceRegime: 'HIGH_VOLATILITY_TREND' as const,
  archetypeWeights: defaultWeights,
};

export const SIMULATION_TEMPLATES: Record<'daily' | 'weekend', SimulationConfig> = {
  daily: {
    ...common,
    template: 'daily',
    baseBankroll: parseMoney('1000.00'),
    initialPrizePool: parseMoney('500.00'),
  },
  weekend: {
    ...common,
    template: 'weekend',
    players: 250,
    steps: 192,
    baseBankroll: parseMoney('2500.00'),
    initialPrizePool: parseMoney('4000.00'),
    entryClosesFraction: 0.8,
  },
};

export function simulationConfig(
  template: 'daily' | 'weekend',
  overrides: Partial<SimulationConfig> = {},
): SimulationConfig {
  const base = SIMULATION_TEMPLATES[template];
  return {
    ...base,
    ...overrides,
    networkEffect: { ...base.networkEffect, ...overrides.networkEffect },
    archetypeWeights: { ...base.archetypeWeights, ...overrides.archetypeWeights },
  };
}
