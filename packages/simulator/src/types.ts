import type { MarketSymbol } from '@trade-the-pool/market-data';
import type { Money, Price } from '@trade-the-pool/shared';
import type { EntryFeeTier, PayoutConfig, RakebackConfig } from '@trade-the-pool/trading-engine';

export type TraderArchetypeName =
  | 'RANDOM'
  | 'WEAK'
  | 'AVERAGE'
  | 'SKILLED'
  | 'HIGH_RISK'
  | 'LATE_ENTRY_OPTIMIZER'
  | 'EARLY_ENTRY_OPTIMIZER'
  | 'REENTRY_OPTIMIZER';

export type TraderArchetype = {
  name: TraderArchetypeName;
  skill: number;
  riskTolerance: number;
  entryTimePreference: number;
  reentryPropensity: number;
  tradeFrequency: number;
  positionConcentrationBasisPoints: number;
  directionalAccuracy: number;
  holdingPeriodSteps: number;
};

export type ArrivalModelName =
  'UNIFORM' | 'EARLY_HEAVY' | 'LATE_HEAVY' | 'SOCIAL_BURSTS' | 'POOL_SIZE_SENSITIVE';

export type PriceRegime =
  'LOW_VOLATILITY_TREND' | 'HIGH_VOLATILITY_TREND' | 'RANGE_CHOP' | 'REVERSAL' | 'SHOCK_EVENT';

export type NetworkEffectConfig = {
  enabled: boolean;
  prizePoolSensitivity: number;
  participantSensitivity: number;
  conclusionSensitivity: number;
};

export type SimulationConfig = {
  template: 'daily' | 'weekend';
  players: number;
  steps: number;
  baseBankroll: Money;
  initialPrizePool: Money;
  tradingStartsFraction: number;
  entryClosesFraction: number;
  maxEntriesPerUser: number;
  feeTiers: EntryFeeTier[];
  payoutConfig: PayoutConfig;
  rakebackConfig: RakebackConfig | null;
  tradingFeeBasisPoints: number;
  positionLimitBasisPoints: number;
  arrivalModel: ArrivalModelName;
  networkEffect: NetworkEffectConfig;
  priceRegime: PriceRegime;
  archetypeWeights: Partial<Record<TraderArchetypeName, number>>;
};

export type PricePath = Readonly<Record<MarketSymbol, readonly Price[]>>;

export interface HistoricalPriceReplaySource {
  readonly source: string;
  loadPricePath(steps: number): Promise<PricePath> | PricePath;
}

export type SimulatedEntry = {
  id: number;
  userId: number;
  userEntryNumber: number;
  tournamentEntryNumber: number;
  archetype: TraderArchetypeName;
  skill: number;
  riskTolerance: number;
  entryFraction: number;
  entryFee: Money;
  prizePoolBeforeEntry: Money;
  prizePoolContribution: Money;
  platformAllocation: Money;
  rakebackAmount: Money;
  baseBankrollSnapshot: Money;
  startingBankroll: Money;
  score: Money;
  equity: Money;
  returnBasisPoints: number;
  rank: number;
  prize: Money;
  competitionEv: Money;
};

export type TournamentSimulation = {
  run: number;
  seed: number;
  finalPrizePool: Money;
  totalEntrants: number;
  uniqueUsers: number;
  totalEntries: number;
  entriesPerUser: number;
  winnerEntryTime: number;
  winnerEntryPercentile: number;
  winnerStartingBankroll: Money;
  winnerPnL: Money;
  winnerReturnBasisPoints: number;
  podiumEntryTimes: number[];
  cashLineEntryTimes: number[];
  platformAllocation: Money;
  feeRevenue: Money;
  prizeGrowth: Money;
  rakeback: Money;
  entries?: SimulatedEntry[];
};

export type AggregateReport = {
  runs: number;
  seed: number;
  configuration: Record<string, unknown>;
  performance: { elapsedMilliseconds: number; tournamentsPerSecond: number };
  averages: {
    entrants: number;
    entries: number;
    finalPrizePool: Money;
    feeRevenue: Money;
    rakeback: Money;
  };
  winnerTimingDistribution: {
    first10Percent: number;
    firstQuartile: number;
    middle50Percent: number;
    finalQuartile: number;
    final10Percent: number;
  };
  expectedPlacementByEntryTime: Record<'early' | 'middle' | 'late', number>;
  expectedValueByEntryTime: Record<'early' | 'middle' | 'late', Money>;
  skillCorrelation: { placement: number; win: number; cash: number };
  reentryAdvantage: {
    multiEntryUserShare: number;
    multiEntryWinnerShare: number;
    averageWinnerEntries: number;
  };
  highRiskDominance: { entryShare: number; winnerShare: number };
  warnings: string[];
  tournaments: TournamentSimulation[];
};
