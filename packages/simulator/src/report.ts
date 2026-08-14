import { moneyToString, signedMoneyToString, type Money } from '@trade-the-pool/shared';
import type { AggregateReport } from './types.js';

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

export function markdownReport(report: AggregateReport): string {
  const warnings = report.warnings.length
    ? report.warnings.map((warning) => `- ${warning}`).join('\n')
    : '- No configured diagnostic threshold was triggered. This does not establish balance.';
  return `# Tournament simulation report

- Runs: ${report.runs.toLocaleString('en-US')}
- Seed: ${report.seed}
- Throughput: ${report.performance.tournamentsPerSecond.toFixed(0)} tournaments/second
- Average entrants: ${report.averages.entrants.toFixed(2)}
- Average entries: ${report.averages.entries.toFixed(2)}
- Average final prize pool: ${moneyToString(report.averages.finalPrizePool)}
- Average net platform allocation: ${moneyToString(report.averages.feeRevenue)}
- Average rakeback: ${moneyToString(report.averages.rakeback)}

## Winner timing

- First 10%: ${percent(report.winnerTimingDistribution.first10Percent)}
- First quartile: ${percent(report.winnerTimingDistribution.firstQuartile)}
- Middle 50%: ${percent(report.winnerTimingDistribution.middle50Percent)}
- Final quartile: ${percent(report.winnerTimingDistribution.finalQuartile)}
- Final 10%: ${percent(report.winnerTimingDistribution.final10Percent)}

## Fairness diagnostics

- Skill / placement correlation: ${report.skillCorrelation.placement.toFixed(4)}
- Skill / win correlation: ${report.skillCorrelation.win.toFixed(4)}
- Skill / cash correlation: ${report.skillCorrelation.cash.toFixed(4)}
- Multi-entry user share: ${percent(report.reentryAdvantage.multiEntryUserShare)}
- Multi-entry winner share: ${percent(report.reentryAdvantage.multiEntryWinnerShare)}
- Average entries held by winner: ${report.reentryAdvantage.averageWinnerEntries.toFixed(2)}
- High-risk entry share: ${percent(report.highRiskDominance.entryShare)}
- High-risk winner share: ${percent(report.highRiskDominance.winnerShare)}

## Warnings

${warnings}

## Interpretation

This is a comparative game-mechanics simulation, not a claim that synthetic traders perfectly
represent real participants. Stochastic price regimes, decision weights, and archetype behavior
are assumptions that must be calibrated against observed alpha behavior.
`;
}

export function jsonReport(report: AggregateReport): string {
  return JSON.stringify(
    report,
    (_key, value: unknown) =>
      typeof value === 'bigint' ? signedMoneyToString(value as Money) : value,
    2,
  );
}

export function tournamentCsv(report: AggregateReport): string {
  const headers = [
    'run',
    'seed',
    'final_prize_pool',
    'unique_users',
    'total_entries',
    'entries_per_user',
    'winner_entry_time',
    'winner_entry_percentile',
    'winner_starting_bankroll',
    'winner_pnl',
    'winner_return_basis_points',
    'fee_revenue',
    'prize_growth',
    'rakeback',
  ];
  const rows = report.tournaments.map((tournament) =>
    [
      tournament.run,
      tournament.seed,
      moneyToString(tournament.finalPrizePool),
      tournament.uniqueUsers,
      tournament.totalEntries,
      tournament.entriesPerUser.toFixed(6),
      tournament.winnerEntryTime.toFixed(8),
      tournament.winnerEntryPercentile.toFixed(8),
      moneyToString(tournament.winnerStartingBankroll),
      tournament.winnerPnL < 0n
        ? `-${moneyToString(-tournament.winnerPnL as Money)}`
        : moneyToString(tournament.winnerPnL),
      tournament.winnerReturnBasisPoints,
      moneyToString(tournament.feeRevenue),
      moneyToString(tournament.prizeGrowth),
      moneyToString(tournament.rakeback),
    ].join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}
