import { describe, expect, it } from 'vitest';
import { moneyToString, parseMoney } from '@trade-the-pool/shared';
import { simulationConfig } from './config.js';
import { runSimulationBatch, simulateTournament } from './simulation.js';

const compact = simulationConfig('daily', { players: 40, steps: 48 });

describe('deterministic tournament simulation', () => {
  it('reproduces identical results from the same seed and configuration', () => {
    const first = runSimulationBatch(compact, 8, 42, { retainEntries: true });
    const second = runSimulationBatch(compact, 8, 42, { retainEntries: true });
    expect({ ...first, performance: undefined }).toEqual({ ...second, performance: undefined });
  });

  it('allows a changed seed to produce a different tournament', () => {
    const first = simulateTournament(compact, 10);
    const second = simulateTournament(compact, 11);
    expect(first.entries?.map((entry) => [entry.entryFraction, entry.score])).not.toEqual(
      second.entries?.map((entry) => [entry.entryFraction, entry.score]),
    );
  });

  it('uses exact fee tiers and immutable bankroll snapshots', () => {
    const result = simulateTournament(compact, 123);
    expect(result.entries?.length).toBeGreaterThan(0);
    for (const entry of result.entries ?? []) {
      const expected = entry.baseBankrollSnapshot + entry.prizePoolBeforeEntry;
      expect(entry.startingBankroll).toBe(expected);
      const tier = compact.feeTiers.find(
        (candidate) =>
          entry.prizePoolBeforeEntry >= candidate.minPrizePool &&
          (candidate.maxPrizePool === null || entry.prizePoolBeforeEntry < candidate.maxPrizePool),
      );
      expect(entry.entryFee).toBe(tier?.entryFee);
    }
  });

  it('records entry timing metrics against the serialized arrival order', () => {
    const result = simulateTournament(compact, 99);
    const entries = result.entries ?? [];
    const ordered = [...entries].sort((left, right) => left.entryFraction - right.entryFraction);
    const winner = entries[0];
    expect(result.winnerEntryPercentile).toBe(
      (ordered.findIndex((entry) => entry.id === winner.id) + 1) / entries.length,
    );
  });

  it('settles configured payouts with exact minor-unit amounts', () => {
    const config = simulationConfig('daily', {
      players: 40,
      steps: 48,
      initialPrizePool: parseMoney('100.00'),
      feeTiers: [
        {
          ordinal: 0,
          minPrizePool: parseMoney('0.00'),
          maxPrizePool: null,
          entryFee: parseMoney('1.00'),
          prizePoolContribution: parseMoney('0.00'),
          platformFee: parseMoney('1.00'),
          futureRewardAllocation: parseMoney('0.00'),
        },
      ],
      payoutConfig: {
        directPrizes: [
          { position: 1, basisPoints: 5000 },
          { position: 2, basisPoints: 3000 },
          { position: 3, basisPoints: 2000 },
        ],
      },
    });
    const result = simulateTournament(config, 333);
    expect(result.entries?.slice(0, 3).map((entry) => moneyToString(entry.prize))).toEqual([
      '50.00',
      '30.00',
      '20.00',
    ]);
  });

  it('keeps re-entries independent and ranks by absolute dollar P&L', () => {
    const config = simulationConfig('daily', {
      players: 50,
      steps: 48,
      archetypeWeights: { REENTRY_OPTIMIZER: 1 },
      maxEntriesPerUser: 3,
    });
    const result = simulateTournament(config, 712);
    const byUser = new Map<number, NonNullable<typeof result.entries>>();
    for (const entry of result.entries ?? [])
      byUser.set(entry.userId, [...(byUser.get(entry.userId) ?? []), entry]);
    const repeated = [...byUser.values()].find((entries) => entries.length > 1);
    expect(repeated).toBeDefined();
    expect(new Set(repeated?.map((entry) => entry.id)).size).toBe(repeated?.length);
    expect(new Set(repeated?.map((entry) => entry.tournamentEntryNumber)).size).toBe(
      repeated?.length,
    );
    const scores = (result.entries ?? []).map((entry) => entry.score);
    expect(scores).toEqual(
      [...scores].sort((left, right) => (left > right ? -1 : left < right ? 1 : 0)),
    );
  });

  it('does not let rakeback alter score, bankroll, fills, or ranking', () => {
    const enabled = simulationConfig('daily', {
      players: 40,
      steps: 48,
      rakebackConfig: { bands: [{ entryCount: 1000, rebateBasisPoints: 5000 }] },
    });
    const without = simulateTournament({ ...enabled, rakebackConfig: null }, 501);
    const withRakeback = simulateTournament(enabled, 501);
    expect(withRakeback.rakeback).toBeGreaterThan(0n);
    expect(
      withRakeback.entries?.map((entry) => [
        entry.id,
        entry.startingBankroll,
        entry.score,
        entry.rank,
      ]),
    ).toEqual(
      without.entries?.map((entry) => [entry.id, entry.startingBankroll, entry.score, entry.rank]),
    );
    expect(moneyToString(withRakeback.finalPrizePool)).toBe(moneyToString(without.finalPrizePool));
  });
});
