import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import {
  orders,
  positions,
  tournamentEntries,
  tournamentSettlementMarks,
  tournaments,
  type Database,
} from '@trade-the-pool/database';
import {
  SUPPORTED_SYMBOLS,
  type MarketPriceProvider,
  type MarketPriceSnapshot,
  type MarketSymbol,
} from '@trade-the-pool/market-data';
import {
  moneyFromMinorUnits,
  parsePrice,
  parseQuantity,
  parseSignedMoney,
  priceToString,
  signedMoneyToString,
  type Price,
} from '@trade-the-pool/shared';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from './config.js';
import {
  accountEquity,
  assertExecutionEligibleSnapshot,
  assertFreshSnapshot,
  unrealizedPnL,
  type ExactPosition,
} from './domain.js';
import { DomainError } from './errors.js';
import { scheduledTournamentStatus } from './lifecycle.js';

export type TournamentSettlementResult = {
  tournamentId: string;
  entryIds: string[];
  settlementMarks: Record<MarketSymbol, string>;
  completedAt: Date;
};

function exactPosition(row: typeof positions.$inferSelect): ExactPosition {
  const quantity = parseQuantity(row.quantity);
  return {
    symbol: row.symbol,
    side: row.side,
    quantity,
    averageEntryPrice: (quantity === 0n ? 0n : parsePrice(row.averageEntryPrice)) as Price,
    realizedPnL: parseSignedMoney(row.realizedPnL),
  };
}

async function settlementSnapshots(
  provider: MarketPriceProvider,
  now: Date,
  config: ExecutionConfig,
): Promise<Map<MarketSymbol, MarketPriceSnapshot>> {
  const marks = new Map<MarketSymbol, MarketPriceSnapshot>();
  for (const symbol of SUPPORTED_SYMBOLS) {
    let snapshot: MarketPriceSnapshot;
    try {
      snapshot = await provider.getSnapshot(symbol);
    } catch {
      throw new DomainError(
        'STALE_MARKET_PRICE',
        `A valid ${symbol} settlement mark is unavailable`,
      );
    }
    assertExecutionEligibleSnapshot(snapshot);
    assertFreshSnapshot(snapshot.marketTimestamp, now, config.stalePriceThresholdMs);
    marks.set(symbol, snapshot);
  }
  return marks;
}

async function completedSettlementResult(
  db: Database,
  tournamentId: string,
  completedAt: Date,
): Promise<TournamentSettlementResult> {
  const existing = await db
    .select()
    .from(tournamentSettlementMarks)
    .where(eq(tournamentSettlementMarks.tournamentId, tournamentId));
  if (existing.length !== SUPPORTED_SYMBOLS.length)
    throw new DomainError(
      'FINANCIAL_INVARIANT_VIOLATION',
      'Completed tournament does not have a complete settlement mark set',
    );
  const entryIds = (
    await db
      .select({ id: tournamentEntries.id })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournamentId))
  ).map((entry) => entry.id);
  return {
    tournamentId,
    entryIds,
    settlementMarks: Object.fromEntries(
      existing.map((mark) => [mark.symbol, mark.price]),
    ) as Record<MarketSymbol, string>,
    completedAt,
  };
}

async function prepareTournamentForSettlement(
  db: Database,
  tournamentId: string,
  now: Date,
): Promise<{ completedAt: Date | null }> {
  return db.transaction(async (tx) => {
    const [tournament] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId))
      .for('update');
    if (!tournament) throw new DomainError('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    const effective = scheduledTournamentStatus(
      tournament.status,
      {
        registrationOpensAt: tournament.registrationOpensAt,
        tradingStartsAt: tournament.tradingStartsAt,
        entryClosesAt: tournament.entryClosesAt,
        tradingClosesAt: tournament.tradingClosesAt,
      },
      now,
    );
    if (effective === 'COMPLETED') return { completedAt: tournament.updatedAt };
    if (effective !== 'TRADING_CLOSED' && effective !== 'FINALIZING')
      throw new DomainError(
        'TOURNAMENT_NOT_TRADABLE',
        'Tournament cannot settle before its trading-close boundary',
      );
    if (effective !== 'FINALIZING')
      await tx
        .update(tournaments)
        .set({ status: 'TRADING_CLOSED', updatedAt: now })
        .where(eq(tournaments.id, tournamentId));
    const entryIds = (
      await tx
        .select({ id: tournamentEntries.id })
        .from(tournamentEntries)
        .where(eq(tournamentEntries.tournamentId, tournamentId))
    ).map((entry) => entry.id);
    if (entryIds.length)
      await tx
        .update(orders)
        .set({
          status: 'EXPIRED',
          cancellationReason: 'Tournament trading closed',
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(orders.entryId, entryIds),
            or(
              eq(orders.status, 'PENDING'),
              eq(orders.status, 'OPEN'),
              eq(orders.status, 'TRIGGERED'),
            ),
          ),
        );
    return { completedAt: null };
  });
}

/**
 * Locks one durable authoritative mark per supported market, expires pending orders, marks every
 * account from those immutable values, and completes the tournament in one database transaction.
 */
export async function settleTournament(
  db: Database,
  provider: MarketPriceProvider,
  tournamentId: string,
  options: { now?: Date; config?: ExecutionConfig } = {},
): Promise<TournamentSettlementResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? DEFAULT_EXECUTION_CONFIG;
  const [current] = await db
    .select({ status: tournaments.status, updatedAt: tournaments.updatedAt })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId));
  if (!current) throw new DomainError('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
  if (current.status === 'COMPLETED')
    return completedSettlementResult(db, tournamentId, current.updatedAt);
  const prepared = await prepareTournamentForSettlement(db, tournamentId, now);
  if (prepared.completedAt)
    return completedSettlementResult(db, tournamentId, prepared.completedAt);
  const snapshots = await settlementSnapshots(provider, now, config);

  return db.transaction(async (tx) => {
    const [tournament] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId))
      .for('update');
    if (!tournament) throw new DomainError('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    const effective = scheduledTournamentStatus(
      tournament.status,
      {
        registrationOpensAt: tournament.registrationOpensAt,
        tradingStartsAt: tournament.tradingStartsAt,
        entryClosesAt: tournament.entryClosesAt,
        tradingClosesAt: tournament.tradingClosesAt,
      },
      now,
    );
    if (effective === 'COMPLETED') {
      const existing = await tx
        .select()
        .from(tournamentSettlementMarks)
        .where(eq(tournamentSettlementMarks.tournamentId, tournamentId));
      if (existing.length !== SUPPORTED_SYMBOLS.length)
        throw new DomainError(
          'FINANCIAL_INVARIANT_VIOLATION',
          'Completed tournament does not have a complete settlement mark set',
        );
      const entryIds = (
        await tx
          .select({ id: tournamentEntries.id })
          .from(tournamentEntries)
          .where(eq(tournamentEntries.tournamentId, tournamentId))
      ).map((entry) => entry.id);
      return {
        tournamentId,
        entryIds,
        settlementMarks: Object.fromEntries(
          existing.map((mark) => [mark.symbol, mark.price]),
        ) as Record<MarketSymbol, string>,
        completedAt: tournament.updatedAt,
      };
    }
    if (effective !== 'TRADING_CLOSED' && effective !== 'FINALIZING')
      throw new DomainError(
        'TOURNAMENT_NOT_TRADABLE',
        'Tournament cannot settle before its trading-close boundary',
      );

    await tx
      .update(tournaments)
      .set({ status: 'FINALIZING', updatedAt: now })
      .where(eq(tournaments.id, tournamentId));
    let lockedMarks = await tx
      .select()
      .from(tournamentSettlementMarks)
      .where(eq(tournamentSettlementMarks.tournamentId, tournamentId));
    if (lockedMarks.length !== 0 && lockedMarks.length !== SUPPORTED_SYMBOLS.length)
      throw new DomainError(
        'FINANCIAL_INVARIANT_VIOLATION',
        'Settlement mark set is incomplete and cannot be mixed with a new snapshot',
      );
    if (lockedMarks.length === 0) {
      lockedMarks = await tx
        .insert(tournamentSettlementMarks)
        .values(
          SUPPORTED_SYMBOLS.map((symbol) => {
            const snapshot = snapshots.get(symbol)!;
            return {
              tournamentId,
              symbol,
              price: priceToString(snapshot.price),
              confidence: snapshot.confidence ? priceToString(snapshot.confidence) : null,
              source: snapshot.source,
              marketTimestamp: snapshot.marketTimestamp,
              lockedAt: now,
            };
          }),
        )
        .returning();
    }
    if (lockedMarks.length !== SUPPORTED_SYMBOLS.length)
      throw new DomainError('FINANCIAL_INVARIANT_VIOLATION', 'Settlement mark set is incomplete');
    const marks = new Map(lockedMarks.map((mark) => [mark.symbol, parsePrice(mark.price)]));

    const entries = await tx
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntries.id))
      .for('update');
    const entryIds = entries.map((entry) => entry.id);
    if (entryIds.length)
      await tx
        .update(orders)
        .set({
          status: 'EXPIRED',
          cancellationReason: 'Tournament trading closed',
          cancelledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(orders.entryId, entryIds),
            or(
              eq(orders.status, 'PENDING'),
              eq(orders.status, 'OPEN'),
              eq(orders.status, 'TRIGGERED'),
            ),
          ),
        );

    for (const entry of entries) {
      const rows = await tx.select().from(positions).where(eq(positions.entryId, entry.id));
      const exact = rows.map(exactPosition);
      let realized = 0n;
      let unrealized = 0n;
      for (const position of exact) {
        realized += position.realizedPnL;
        if (position.quantity > 0n)
          unrealized += unrealizedPnL(position, marks.get(position.symbol)!);
      }
      const equity = accountEquity(parseSignedMoney(entry.cash), exact, marks);
      await tx
        .update(tournamentEntries)
        .set({
          realizedPnL: signedMoneyToString(moneyFromMinorUnits(realized)),
          unrealizedPnL: signedMoneyToString(moneyFromMinorUnits(unrealized)),
          currentEquity: signedMoneyToString(equity),
          updatedAt: now,
        })
        .where(eq(tournamentEntries.id, entry.id));
    }
    await tx
      .update(tournaments)
      .set({ status: 'COMPLETED', updatedAt: now })
      .where(eq(tournaments.id, tournamentId));
    return {
      tournamentId,
      entryIds,
      settlementMarks: Object.fromEntries(
        lockedMarks.map((mark) => [mark.symbol, mark.price]),
      ) as Record<MarketSymbol, string>,
      completedAt: now,
    };
  });
}

export async function settleDueTournaments(
  db: Database,
  provider: MarketPriceProvider,
  now = new Date(),
): Promise<TournamentSettlementResult[]> {
  const due = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(
      and(
        lte(tournaments.tradingClosesAt, now),
        inArray(tournaments.status, [
          'DRAFT',
          'REGISTRATION_OPEN',
          'TRADING_ACTIVE',
          'ENTRY_CLOSED',
          'TRADING_CLOSED',
          'FINALIZING',
        ]),
      ),
    );
  const results: TournamentSettlementResult[] = [];
  for (const tournament of due)
    results.push(await settleTournament(db, provider, tournament.id, { now }));
  return results;
}
