import { and, count, eq } from 'drizzle-orm';
import type { Database } from '@trade-the-pool/database';
import {
  accountLedgerEntries,
  tournamentEntries,
  tournaments,
  users,
} from '@trade-the-pool/database';
import { addMoney, moneyToString, parseMoney, type Money } from '@trade-the-pool/shared';
import { DomainError } from './errors.js';

export { DomainError } from './errors.js';
export type { DomainErrorCode } from './errors.js';
export * from './config.js';
export * from './domain.js';
export * from './service.js';

export type TournamentStatus =
  'DRAFT' | 'OPEN' | 'ENTRY_CLOSED' | 'TRADING_CLOSED' | 'FINALIZING' | 'COMPLETED' | 'CANCELLED';
const transitions: Record<Exclude<TournamentStatus, 'CANCELLED'>, readonly TournamentStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['ENTRY_CLOSED', 'CANCELLED'],
  ENTRY_CLOSED: ['TRADING_CLOSED', 'CANCELLED'],
  TRADING_CLOSED: ['FINALIZING', 'CANCELLED'],
  FINALIZING: ['COMPLETED'],
  COMPLETED: [],
};
export function transitionTournament(
  status: TournamentStatus,
  next: TournamentStatus,
): TournamentStatus {
  if (status === 'CANCELLED' || !transitions[status].includes(next))
    throw new DomainError(
      'INVALID_TOURNAMENT_TRANSITION',
      `Cannot transition tournament from ${status} to ${next}`,
    );
  return next;
}

export type EntryEligibility = {
  status: TournamentStatus;
  entryClosesAt: Date | null;
  maxEntriesPerUser: number;
  entryCount: number;
  pool: Money;
  contribution: Money;
  userExists: boolean;
};
export function assertEntryEligibility(input: EntryEligibility, now: Date): void {
  if (!input.userExists) throw new DomainError('USER_NOT_FOUND', 'User does not exist');
  if (input.status !== 'OPEN')
    throw new DomainError('TOURNAMENT_NOT_OPEN', 'Tournament is not open for entries');
  if (input.entryClosesAt && now >= input.entryClosesAt)
    throw new DomainError('ENTRY_CLOSED', 'Tournament entry period has closed');
  if (input.entryCount >= input.maxEntriesPerUser)
    throw new DomainError('ENTRY_LIMIT_REACHED', 'User has reached the tournament entry limit');
  if (input.pool <= 0n) throw new DomainError('INVALID_POOL', 'Simulated pool must be positive');
  if (input.contribution < 0n)
    throw new DomainError(
      'INVALID_CONTRIBUTION',
      'Simulated entry contribution cannot be negative',
    );
}

export type CreatedEntry = {
  id: string;
  tournamentId: string;
  userId: string;
  sequenceNumber: number;
  startingBankroll: string;
  cash: string;
  realizedPnL: string;
  unrealizedPnL: string;
  currentEquity: string;
  updatedPool: string;
  createdAt: Date;
  updatedAt: Date;
};
/** The locked tournament row serializes all entrants, so each snapshot precedes exactly one pool increment. */
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
    const [{ value: entryCount }] = await tx
      .select({ value: count() })
      .from(tournamentEntries)
      .where(
        and(eq(tournamentEntries.tournamentId, tournamentId), eq(tournamentEntries.userId, userId)),
      );
    const pool = parseMoney(tournament.simulatedPool);
    const contribution = parseMoney(tournament.simulatedEntryContribution);
    assertEntryEligibility(
      {
        status: tournament.status,
        entryClosesAt: tournament.entryClosesAt,
        maxEntriesPerUser: tournament.maxEntriesPerUser,
        entryCount: Number(entryCount),
        pool,
        contribution,
        userExists: Boolean(user),
      },
      now,
    );
    const sequenceNumber = Number(entryCount) + 1;
    const updatedPool = addMoney(pool, contribution);
    const bankroll = moneyToString(pool);
    const [entry] = await tx
      .insert(tournamentEntries)
      .values({
        tournamentId,
        userId,
        sequenceNumber,
        startingBankroll: bankroll,
        cash: bankroll,
        realizedPnL: '0.00',
        unrealizedPnL: '0.00',
        currentEquity: bankroll,
      })
      .returning();
    await tx.insert(accountLedgerEntries).values({
      entryId: entry.id,
      type: 'ACCOUNT_INITIALIZED',
      amount: bankroll,
      referenceType: 'TOURNAMENT_ENTRY',
      referenceId: entry.id,
      metadata: { tournamentId, startingBankroll: bankroll },
      createdAt: now,
    });
    await tx
      .update(tournaments)
      .set({ simulatedPool: moneyToString(updatedPool), updatedAt: now })
      .where(eq(tournaments.id, tournamentId));
    return {
      ...entry,
      startingBankroll: bankroll,
      cash: bankroll,
      realizedPnL: '0.00',
      unrealizedPnL: '0.00',
      currentEquity: bankroll,
      updatedPool: moneyToString(updatedPool),
    };
  });
}
export function serializeMoney(value: Money): string {
  return moneyToString(value);
}
