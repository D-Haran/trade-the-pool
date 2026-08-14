import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from '@trade-the-pool/database';
import {
  accountLedgerEntries,
  tournamentEntries,
  tournamentEntryFeeTiers,
  tournaments,
  users,
} from '@trade-the-pool/database';
import { addMoney, moneyToString, parseMoney, type Money } from '@trade-the-pool/shared';
import {
  applicableEntryFeeTier,
  calculateNewEntryBankroll,
  calculateRakeback,
  type EntryFeeTier,
} from './economics.js';
import { DomainError } from './errors.js';
import { assertEntryWindow, type TournamentSchedule, type TournamentStatus } from './lifecycle.js';

export { DomainError } from './errors.js';
export type { DomainErrorCode } from './errors.js';
export * from './config.js';
export * from './domain.js';
export * from './economics.js';
export * from './lifecycle.js';
export * from './service.js';
export * from './professional-service.js';
export * from './settlement.js';

export type EntryEligibility = {
  status: TournamentStatus;
  schedule: TournamentSchedule;
  maxEntriesPerUser: number;
  entryCount: number;
  baseBankroll: Money;
  currentPrizePool: Money;
  userExists: boolean;
};

export function assertEntryEligibility(input: EntryEligibility, now: Date): void {
  if (!input.userExists) throw new DomainError('USER_NOT_FOUND', 'User does not exist');
  assertEntryWindow(input.status, input.schedule, now);
  if (input.entryCount >= input.maxEntriesPerUser)
    throw new DomainError('ENTRY_LIMIT_REACHED', 'User has reached the tournament entry limit');
  if (input.baseBankroll < 0n)
    throw new DomainError('INVALID_POOL', 'Base bankroll cannot be negative');
  if (input.currentPrizePool < 0n)
    throw new DomainError('INVALID_POOL', 'Current prize pool cannot be negative');
  if (input.baseBankroll + input.currentPrizePool <= 0n)
    throw new DomainError('INVALID_POOL', 'New entry bankroll must be positive');
}

export type CreatedEntry = {
  id: string;
  tournamentId: string;
  userId: string;
  sequenceNumber: number;
  tournamentEntryNumber: number;
  entryFee: string;
  prizePoolBeforeEntry: string;
  prizePoolContribution: string;
  platformAllocation: string;
  futureRewardAllocation: string;
  rakebackAmount: string;
  baseBankrollSnapshot: string;
  startingBankroll: string;
  cash: string;
  realizedPnL: string;
  unrealizedPnL: string;
  currentEquity: string;
  currentPrizePool: string;
  newEntryBankroll: string;
  currentEntryFee: string;
  createdAt: Date;
  updatedAt: Date;
};

function exactTier(row: typeof tournamentEntryFeeTiers.$inferSelect): EntryFeeTier {
  return {
    ordinal: row.ordinal,
    minPrizePool: parseMoney(row.minPrizePool),
    maxPrizePool: row.maxPrizePool === null ? null : parseMoney(row.maxPrizePool),
    entryFee: parseMoney(row.entryFee),
    prizePoolContribution: parseMoney(row.prizePoolContribution),
    platformFee: parseMoney(row.platformFee),
    futureRewardAllocation: parseMoney(row.futureRewardAllocation),
  };
}

/**
 * The locked tournament row serializes every entrant. Fee selection and all immutable snapshots
 * are therefore based on one authoritative pre-entry prize pool, including at tier boundaries.
 */
export async function createTournamentEntry(
  db: Database,
  tournamentId: string,
  userId: string,
  now = new Date(),
): Promise<CreatedEntry> {
  return db.transaction(async (tx) => {
    const [tournament] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId))
      .for('update');
    if (!tournament) throw new DomainError('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    const [{ value: userEntryCount }] = await tx
      .select({ value: count() })
      .from(tournamentEntries)
      .where(
        and(eq(tournamentEntries.tournamentId, tournamentId), eq(tournamentEntries.userId, userId)),
      );
    const [{ value: tournamentEntryCount }] = await tx
      .select({ value: count() })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournamentId));
    const tierRows = await tx
      .select()
      .from(tournamentEntryFeeTiers)
      .where(eq(tournamentEntryFeeTiers.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntryFeeTiers.ordinal));
    const tiers = tierRows.map(exactTier);
    const baseBankroll = parseMoney(tournament.baseBankroll);
    const currentPrizePool = parseMoney(tournament.currentPrizePool);
    assertEntryEligibility(
      {
        status: tournament.status,
        schedule: {
          registrationOpensAt: tournament.registrationOpensAt,
          tradingStartsAt: tournament.tradingStartsAt,
          entryClosesAt: tournament.entryClosesAt,
          tradingClosesAt: tournament.tradingClosesAt,
        },
        maxEntriesPerUser: tournament.maxEntriesPerUser,
        entryCount: Number(userEntryCount),
        baseBankroll,
        currentPrizePool,
        userExists: Boolean(user),
      },
      now,
    );
    const tier = applicableEntryFeeTier(tiers, currentPrizePool);
    const sequenceNumber = Number(userEntryCount) + 1;
    const tournamentEntryNumber = Number(tournamentEntryCount) + 1;
    const bankroll = calculateNewEntryBankroll(baseBankroll, currentPrizePool);
    const updatedPrizePool = addMoney(currentPrizePool, tier.prizePoolContribution);
    const rakebackAmount = calculateRakeback(
      tier.platformFee,
      tournamentEntryNumber,
      tournament.rakebackConfig,
    );
    const serialized = {
      entryFee: moneyToString(tier.entryFee),
      prizePoolBeforeEntry: moneyToString(currentPrizePool),
      prizePoolContribution: moneyToString(tier.prizePoolContribution),
      platformAllocation: moneyToString(tier.platformFee),
      futureRewardAllocation: moneyToString(tier.futureRewardAllocation),
      rakebackAmount: moneyToString(rakebackAmount),
      baseBankrollSnapshot: moneyToString(baseBankroll),
      startingBankroll: moneyToString(bankroll),
    };
    const [entry] = await tx
      .insert(tournamentEntries)
      .values({
        tournamentId,
        userId,
        sequenceNumber,
        tournamentEntryNumber,
        ...serialized,
        cash: serialized.startingBankroll,
        realizedPnL: '0.00',
        unrealizedPnL: '0.00',
        currentEquity: serialized.startingBankroll,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(accountLedgerEntries).values({
      entryId: entry.id,
      type: 'ACCOUNT_INITIALIZED',
      amount: serialized.startingBankroll,
      referenceType: 'TOURNAMENT_ENTRY',
      referenceId: entry.id,
      metadata: {
        tournamentId,
        tournamentEntryNumber,
        ...serialized,
      },
      createdAt: now,
    });
    await tx
      .update(tournaments)
      .set({ currentPrizePool: moneyToString(updatedPrizePool), updatedAt: now })
      .where(eq(tournaments.id, tournamentId));
    const nextTier = applicableEntryFeeTier(tiers, updatedPrizePool);
    return {
      ...entry,
      ...serialized,
      cash: serialized.startingBankroll,
      realizedPnL: '0.00',
      unrealizedPnL: '0.00',
      currentEquity: serialized.startingBankroll,
      currentPrizePool: moneyToString(updatedPrizePool),
      newEntryBankroll: moneyToString(calculateNewEntryBankroll(baseBankroll, updatedPrizePool)),
      currentEntryFee: moneyToString(nextTier.entryFee),
    };
  });
}
