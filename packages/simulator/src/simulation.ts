import { SUPPORTED_SYMBOLS } from '@trade-the-pool/market-data';
import {
  applyBasisPoints,
  divideRoundHalfUp,
  moneyFromMinorUnits,
  moneyToString,
  type Money,
} from '@trade-the-pool/shared';
import {
  applicableEntryFeeTier,
  calculateNewEntryBankroll,
  calculateRakeback,
  projectPayouts,
  validateEntryFeeTiers,
  validatePayoutConfig,
} from '@trade-the-pool/trading-engine';
import { TRADER_ARCHETYPES } from './config.js';
import { generatePricePath } from './price-path.js';
import { SeededRandom } from './rng.js';
import type {
  AggregateReport,
  PricePath,
  SimulatedEntry,
  SimulationConfig,
  TournamentSimulation,
  TraderArchetype,
  TraderArchetypeName,
} from './types.js';

type SyntheticUser = { id: number; archetype: TraderArchetype; entries: SimulatedEntry[] };
type ArrivalEvent = { fraction: number; user: SyntheticUser; reentry: boolean };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function arrivalFraction(config: SimulationConfig, rng: SeededRandom): number {
  const value = rng.next();
  switch (config.arrivalModel) {
    case 'EARLY_HEAVY':
      return value * value;
    case 'LATE_HEAVY':
      return 1 - value * value;
    case 'SOCIAL_BURSTS': {
      const center = [0.18, 0.5, 0.78][rng.integer(3)];
      return clamp(center + rng.normal() * 0.035, 0, 0.999999);
    }
    case 'POOL_SIZE_SENSITIVE':
      return 1 - value ** 1.45;
    default:
      return value;
  }
}

function selectArchetype(config: SimulationConfig, rng: SeededRandom): TraderArchetype {
  const names = Object.keys(TRADER_ARCHETYPES) as TraderArchetypeName[];
  const total = names.reduce((sum, name) => sum + (config.archetypeWeights[name] ?? 0), 0);
  if (total <= 0) throw new Error('Archetype weights must have a positive total');
  let target = rng.next() * total;
  for (const name of names) {
    target -= config.archetypeWeights[name] ?? 0;
    if (target <= 0) return TRADER_ARCHETYPES[name];
  }
  return TRADER_ARCHETYPES[names.at(-1)!];
}

function relativeBasisPoints(value: Money, base: Money): number {
  if (base <= 0n) return 0;
  return Number((value * 10_000n) / base);
}

function entryProbability(
  config: SimulationConfig,
  user: SyntheticUser,
  fraction: number,
  currentPrizePool: Money,
  currentEntryFee: Money,
  participants: number,
): number {
  const archetype = user.archetype;
  const timeRemaining = 1 - fraction;
  const bankroll = calculateNewEntryBankroll(config.baseBankroll, currentPrizePool);
  const bankrollGrowth = relativeBasisPoints(bankroll, config.baseBankroll) / 10_000 - 1;
  const pricePenalty = Number(currentEntryFee) / Math.max(1, Number(bankroll));
  const timingFit = archetype.entryTimePreference * (fraction * 2 - 1);
  let probability =
    0.58 +
    bankrollGrowth * 0.08 +
    timingFit * 0.24 +
    timeRemaining * 0.12 -
    pricePenalty * 8 -
    Math.max(0, participants - config.players * 0.8) / config.players / 5;
  if (config.networkEffect.enabled) {
    const prizeGrowth = relativeBasisPoints(currentPrizePool, config.initialPrizePool) / 10_000 - 1;
    probability += prizeGrowth * config.networkEffect.prizePoolSensitivity;
    probability +=
      (participants / Math.max(1, config.players)) * config.networkEffect.participantSensitivity;
    probability += fraction * config.networkEffect.conclusionSensitivity;
  }
  if (user.entries.length > 0) {
    const latest = user.entries.at(-1)!;
    const bankrollAdvantage =
      Number(bankroll - latest.startingBankroll) / Number(config.baseBankroll);
    const estimatedExistingPnl = Number(latest.score) * clamp(fraction, 0.1, 1);
    probability =
      archetype.reentryPropensity +
      bankrollAdvantage * (archetype.name === 'REENTRY_OPTIMIZER' ? 0.9 : 0.45) -
      (Math.max(0, estimatedExistingPnl) / Math.max(1, Number(latest.startingBankroll))) * 0.2 -
      user.entries.length * 0.12;
  }
  return clamp(probability, 0.01, 0.98);
}

function candidateReturn(
  path: PricePath,
  entryStep: number,
  holdingSteps: number,
  rng: SeededRandom,
): number {
  const symbol = SUPPORTED_SYMBOLS[rng.integer(SUPPORTED_SYMBOLS.length)];
  const available = path[symbol].length - entryStep - 1;
  const start = entryStep + rng.integer(Math.max(1, available));
  const end = Math.min(path[symbol].length - 1, start + Math.max(1, holdingSteps));
  const startPrice = path[symbol][start];
  return Number(((path[symbol][end] - startPrice) * 10_000n) / startPrice);
}

export function simulateTradingScore(
  config: SimulationConfig,
  archetype: TraderArchetype,
  startingBankroll: Money,
  entryFraction: number,
  path: PricePath,
  rng: SeededRandom,
): Money {
  const entryStep = Math.max(
    Math.floor(config.steps * config.tradingStartsFraction),
    Math.floor(entryFraction * (config.steps - 1)),
  );
  const availableSteps = Math.max(1, config.steps - entryStep - 1);
  const trades = Math.max(
    1,
    Math.round(
      (availableSteps / Math.max(2, archetype.holdingPeriodSteps)) * archetype.tradeFrequency,
    ),
  );
  const concentration = Math.min(
    config.positionLimitBasisPoints,
    archetype.positionConcentrationBasisPoints,
  );
  const notional = moneyFromMinorUnits((startingBankroll * BigInt(concentration)) / 10_000n);
  let score = moneyFromMinorUnits(0n);
  for (let trade = 0; trade < trades; trade += 1) {
    const candidates = Array.from({ length: 3 }, () =>
      candidateReturn(path, entryStep, archetype.holdingPeriodSteps, rng),
    );
    const informed = rng.next() < archetype.directionalAccuracy + archetype.skill * 0.08;
    const returnBasisPoints = informed
      ? Math.max(...candidates)
      : candidates[rng.integer(candidates.length)];
    const gross = divideRoundHalfUp(notional * BigInt(returnBasisPoints), 10_000n);
    const costs = applyBasisPoints(notional, BigInt(config.tradingFeeBasisPoints * 2));
    score = moneyFromMinorUnits(score + gross - costs);
  }
  return score < -startingBankroll ? moneyFromMinorUnits(-startingBankroll) : score;
}

export function simulateTournament(
  config: SimulationConfig,
  seed: number,
  run = 0,
  suppliedPath?: PricePath,
): TournamentSimulation {
  validateEntryFeeTiers(config.feeTiers);
  validatePayoutConfig(config.payoutConfig);
  const rng = new SeededRandom(seed);
  const path = suppliedPath ?? generatePricePath(config.priceRegime, config.steps, rng.fork(7));
  const users: SyntheticUser[] = Array.from({ length: config.players }, (_, id) => ({
    id,
    archetype: selectArchetype(config, rng),
    entries: [],
  }));
  const events: ArrivalEvent[] = users.map((user) => ({
    fraction: Math.min(
      config.entryClosesFraction - Number.EPSILON,
      clamp(
        arrivalFraction(config, rng) + user.archetype.entryTimePreference * 0.08,
        0,
        config.entryClosesFraction - Number.EPSILON,
      ),
    ),
    user,
    reentry: false,
  }));
  events.sort((left, right) => left.fraction - right.fraction || left.user.id - right.user.id);
  const entries: SimulatedEntry[] = [];
  let currentPrizePool = config.initialPrizePool;
  let platformAllocation = moneyFromMinorUnits(0n);
  let totalRakeback = moneyFromMinorUnits(0n);

  while (events.length > 0) {
    const event = events.shift()!;
    if (event.fraction >= config.entryClosesFraction) continue;
    const tier = applicableEntryFeeTier(config.feeTiers, currentPrizePool);
    const probability = entryProbability(
      config,
      event.user,
      event.fraction,
      currentPrizePool,
      tier.entryFee,
      entries.length,
    );
    if (rng.next() > probability) continue;
    const tournamentEntryNumber = entries.length + 1;
    const startingBankroll = calculateNewEntryBankroll(config.baseBankroll, currentPrizePool);
    const rakebackAmount = calculateRakeback(
      tier.platformFee,
      tournamentEntryNumber,
      config.rakebackConfig,
    );
    const score = simulateTradingScore(
      config,
      event.user.archetype,
      startingBankroll,
      event.fraction,
      path,
      rng,
    );
    const entry: SimulatedEntry = {
      id: entries.length + 1,
      userId: event.user.id,
      userEntryNumber: event.user.entries.length + 1,
      tournamentEntryNumber,
      archetype: event.user.archetype.name,
      skill: event.user.archetype.skill,
      riskTolerance: event.user.archetype.riskTolerance,
      entryFraction: event.fraction,
      entryFee: tier.entryFee,
      prizePoolBeforeEntry: currentPrizePool,
      prizePoolContribution: tier.prizePoolContribution,
      platformAllocation: tier.platformFee,
      rakebackAmount,
      baseBankrollSnapshot: config.baseBankroll,
      startingBankroll,
      score,
      equity: moneyFromMinorUnits(startingBankroll + score),
      returnBasisPoints: Number(divideRoundHalfUp(score * 10_000n, startingBankroll)),
      rank: 0,
      prize: moneyFromMinorUnits(0n),
      competitionEv: moneyFromMinorUnits(0n),
    };
    entries.push(entry);
    event.user.entries.push(entry);
    currentPrizePool = moneyFromMinorUnits(currentPrizePool + tier.prizePoolContribution);
    platformAllocation = moneyFromMinorUnits(platformAllocation + tier.platformFee);
    totalRakeback = moneyFromMinorUnits(totalRakeback + rakebackAmount);

    if (event.user.entries.length < config.maxEntriesPerUser) {
      const remaining = config.entryClosesFraction - event.fraction;
      const nextFraction = event.fraction + remaining * (0.2 + rng.next() * 0.65);
      events.push({ fraction: nextFraction, user: event.user, reentry: true });
      events.sort((left, right) => left.fraction - right.fraction || left.user.id - right.user.id);
    }
  }

  entries.sort((left, right) =>
    left.score === right.score
      ? left.tournamentEntryNumber - right.tournamentEntryNumber
      : left.score > right.score
        ? -1
        : 1,
  );
  const projection = projectPayouts(currentPrizePool, config.payoutConfig, entries.length);
  for (const [index, entry] of entries.entries()) {
    entry.rank = index + 1;
    entry.prize =
      projection.prizes.find((prize) => prize.position === entry.rank)?.amount ?? (0n as Money);
    entry.competitionEv = moneyFromMinorUnits(entry.prize + entry.rakebackAmount - entry.entryFee);
  }
  const winner = entries[0];
  const entryTimes = [...entries].sort((left, right) => left.entryFraction - right.entryFraction);
  const winnerArrivalIndex = winner ? entryTimes.findIndex((entry) => entry.id === winner.id) : -1;
  const uniqueUsers = new Set(entries.map((entry) => entry.userId)).size;
  const cashLine = entries.slice(0, projection.cashLinePosition);
  return {
    run,
    seed,
    finalPrizePool: currentPrizePool,
    totalEntrants: entries.length,
    uniqueUsers,
    totalEntries: entries.length,
    entriesPerUser: uniqueUsers === 0 ? 0 : entries.length / uniqueUsers,
    winnerEntryTime: winner?.entryFraction ?? 0,
    winnerEntryPercentile:
      winnerArrivalIndex < 0 || entries.length === 0
        ? 0
        : (winnerArrivalIndex + 1) / entries.length,
    winnerStartingBankroll: winner?.startingBankroll ?? moneyFromMinorUnits(0n),
    winnerPnL: winner?.score ?? moneyFromMinorUnits(0n),
    winnerReturnBasisPoints: winner?.returnBasisPoints ?? 0,
    podiumEntryTimes: entries.slice(0, 3).map((entry) => entry.entryFraction),
    cashLineEntryTimes: cashLine.map((entry) => entry.entryFraction),
    platformAllocation,
    feeRevenue: moneyFromMinorUnits(platformAllocation - totalRakeback),
    prizeGrowth: moneyFromMinorUnits(currentPrizePool - config.initialPrizePool),
    rakeback: totalRakeback,
    entries,
  };
}

type Correlation = { n: number; x: number; y: number; xx: number; yy: number; xy: number };
function addCorrelation(state: Correlation, x: number, y: number): void {
  state.n += 1;
  state.x += x;
  state.y += y;
  state.xx += x * x;
  state.yy += y * y;
  state.xy += x * y;
}
function correlation(state: Correlation): number {
  const numerator = state.n * state.xy - state.x * state.y;
  const denominator = Math.sqrt(
    (state.n * state.xx - state.x ** 2) * (state.n * state.yy - state.y ** 2),
  );
  return denominator === 0 ? 0 : numerator / denominator;
}

function timingGroup(fraction: number): 'early' | 'middle' | 'late' {
  return fraction < 0.25 ? 'early' : fraction >= 0.75 ? 'late' : 'middle';
}

export function serializableConfig(config: SimulationConfig): Record<string, unknown> {
  return {
    ...config,
    baseBankroll: moneyToString(config.baseBankroll),
    initialPrizePool: moneyToString(config.initialPrizePool),
    feeTiers: config.feeTiers.map((tier) => ({
      ...tier,
      minPrizePool: moneyToString(tier.minPrizePool),
      maxPrizePool: tier.maxPrizePool === null ? null : moneyToString(tier.maxPrizePool),
      entryFee: moneyToString(tier.entryFee),
      prizePoolContribution: moneyToString(tier.prizePoolContribution),
      platformFee: moneyToString(tier.platformFee),
      futureRewardAllocation: moneyToString(tier.futureRewardAllocation),
    })),
  };
}

export function runSimulationBatch(
  config: SimulationConfig,
  runs: number,
  seed: number,
  options: { retainEntries?: boolean } = {},
): AggregateReport {
  if (!Number.isInteger(runs) || runs <= 0) throw new Error('Runs must be a positive integer');
  const started = performance.now();
  const tournaments: TournamentSimulation[] = [];
  let totalEntrants = 0;
  let totalEntries = 0;
  let totalFinalPool = 0n;
  let totalFeeRevenue = 0n;
  let totalRakeback = 0n;
  const winnerTiming = { first10: 0, firstQuarter: 0, middle: 0, finalQuarter: 0, final10: 0 };
  const groupStats = {
    early: { count: 0, placement: 0, ev: 0n },
    middle: { count: 0, placement: 0, ev: 0n },
    late: { count: 0, placement: 0, ev: 0n },
  };
  const skillPlacement: Correlation = { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 };
  const skillWin: Correlation = { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 };
  const skillCash: Correlation = { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 };
  let multiEntryUsers = 0;
  let allUsers = 0;
  let multiEntryWinners = 0;
  let winnerEntryCounts = 0;
  let highRiskEntries = 0;
  let highRiskWinners = 0;

  for (let run = 0; run < runs; run += 1) {
    const runSeed = (seed + Math.imul(run + 1, 0x9e3779b1)) | 0;
    const result = simulateTournament(config, runSeed, run);
    const entries = result.entries ?? [];
    totalEntrants += result.totalEntrants;
    totalEntries += result.totalEntries;
    totalFinalPool += result.finalPrizePool;
    totalFeeRevenue += result.feeRevenue;
    totalRakeback += result.rakeback;
    const timing = result.winnerEntryPercentile;
    if (timing <= 0.1) winnerTiming.first10 += 1;
    if (timing <= 0.25) winnerTiming.firstQuarter += 1;
    if (timing > 0.25 && timing < 0.75) winnerTiming.middle += 1;
    if (timing >= 0.75) winnerTiming.finalQuarter += 1;
    if (timing >= 0.9) winnerTiming.final10 += 1;
    const paid = new Set(entries.filter((entry) => entry.prize > 0n).map((entry) => entry.id));
    const counts = new Map<number, number>();
    for (const entry of entries) counts.set(entry.userId, (counts.get(entry.userId) ?? 0) + 1);
    allUsers += counts.size;
    multiEntryUsers += [...counts.values()].filter((count) => count > 1).length;
    const winner = entries[0];
    if (winner) {
      const winnerCount = counts.get(winner.userId) ?? 1;
      winnerEntryCounts += winnerCount;
      if (winnerCount > 1) multiEntryWinners += 1;
      if (winner.archetype === 'HIGH_RISK') highRiskWinners += 1;
    }
    for (const entry of entries) {
      if (entry.archetype === 'HIGH_RISK') highRiskEntries += 1;
      const group = groupStats[timingGroup(entry.entryFraction)];
      group.count += 1;
      const placementScore = entries.length <= 1 ? 1 : 1 - (entry.rank - 1) / (entries.length - 1);
      group.placement += placementScore;
      group.ev += entry.competitionEv;
      addCorrelation(skillPlacement, entry.skill, placementScore);
      addCorrelation(skillWin, entry.skill, entry.rank === 1 ? 1 : 0);
      addCorrelation(skillCash, entry.skill, paid.has(entry.id) ? 1 : 0);
    }
    if (!options.retainEntries) delete result.entries;
    tournaments.push(result);
  }
  const elapsedMilliseconds = performance.now() - started;
  const ratio = (value: number) => value / runs;
  const expectedPlacementByEntryTime = Object.fromEntries(
    Object.entries(groupStats).map(([key, value]) => [
      key,
      value.count ? value.placement / value.count : 0,
    ]),
  ) as AggregateReport['expectedPlacementByEntryTime'];
  const expectedValueByEntryTime = Object.fromEntries(
    Object.entries(groupStats).map(([key, value]) => [
      key,
      moneyFromMinorUnits(value.count ? value.ev / BigInt(value.count) : 0n),
    ]),
  ) as AggregateReport['expectedValueByEntryTime'];
  const multiEntryUserShare = allUsers ? multiEntryUsers / allUsers : 0;
  const multiEntryWinnerShare = multiEntryWinners / runs;
  const highRiskEntryShare = totalEntries ? highRiskEntries / totalEntries : 0;
  const highRiskWinnerShare = highRiskWinners / runs;
  const warnings: string[] = [];
  if (ratio(winnerTiming.final10) > 0.25)
    warnings.push('Late-entry warning: more than 25% of winners entered in the final 10%.');
  if (expectedPlacementByEntryTime.early < 0.35)
    warnings.push('Early-entry warning: early entries have weak expected placement.');
  if (highRiskWinnerShare > highRiskEntryShare * 1.75)
    warnings.push('Risk warning: high-risk entries win far above their population share.');
  if (multiEntryWinnerShare > multiEntryUserShare * 1.75)
    warnings.push('Re-entry warning: multi-entry users win far above their user share.');
  if (totalEntries / runs < config.players * 0.25)
    warnings.push('Growth warning: participation stalls under the configured decision model.');
  if (multiEntryWinnerShare > 0.7)
    warnings.push('Re-entry warning: multiple entries appear effectively mandatory for winners.');
  return {
    runs,
    seed,
    configuration: serializableConfig(config),
    performance: {
      elapsedMilliseconds,
      tournamentsPerSecond: runs / Math.max(0.001, elapsedMilliseconds / 1000),
    },
    averages: {
      entrants: totalEntrants / runs,
      entries: totalEntries / runs,
      finalPrizePool: moneyFromMinorUnits(totalFinalPool / BigInt(runs)),
      feeRevenue: moneyFromMinorUnits(totalFeeRevenue / BigInt(runs)),
      rakeback: moneyFromMinorUnits(totalRakeback / BigInt(runs)),
    },
    winnerTimingDistribution: {
      first10Percent: ratio(winnerTiming.first10),
      firstQuartile: ratio(winnerTiming.firstQuarter),
      middle50Percent: ratio(winnerTiming.middle),
      finalQuartile: ratio(winnerTiming.finalQuarter),
      final10Percent: ratio(winnerTiming.final10),
    },
    expectedPlacementByEntryTime,
    expectedValueByEntryTime,
    skillCorrelation: {
      placement: correlation(skillPlacement),
      win: correlation(skillWin),
      cash: correlation(skillCash),
    },
    reentryAdvantage: {
      multiEntryUserShare,
      multiEntryWinnerShare,
      averageWinnerEntries: winnerEntryCounts / runs,
    },
    highRiskDominance: { entryShare: highRiskEntryShare, winnerShare: highRiskWinnerShare },
    warnings,
    tournaments,
  };
}
