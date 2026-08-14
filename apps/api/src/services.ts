import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  fills,
  orders,
  positions,
  tournamentEntries,
  tournaments,
  users,
  type Database,
} from '@trade-the-pool/database';
import {
  SUPPORTED_SYMBOLS,
  type MarketPriceProvider,
  type MarketSymbol,
} from '@trade-the-pool/market-data';
import {
  divideRoundHalfUp,
  moneyFromMinorUnits,
  parseMoney,
  signedMoneyToString,
  type RealtimeEvent,
} from '@trade-the-pool/shared';
import {
  createTournamentEntry,
  executeMarketOrder,
  getAccountSummary,
  type MarketOrderRequest,
} from '@trade-the-pool/trading-engine';
import type { KeyValueStore } from './infrastructure.js';
import { ApiError } from './errors.js';

export interface EventPublisher {
  publish(topic: string, event: RealtimeEvent): void;
}

export type Pagination = { page: number; pageSize: number };

function pageMetadata(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

export class AccountSnapshotService {
  constructor(
    private readonly db: Database,
    private readonly market: MarketPriceProvider,
  ) {}

  async get(entryId: string) {
    const [entry] = await this.db
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, entryId));
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Tournament entry does not exist.');
    const account = await getAccountSummary(this.db, this.market, entryId);
    const score = moneyFromMinorUnits(
      parseMoney(account.equity) - parseMoney(entry.startingBankroll),
    );
    return {
      ...account,
      startingBankroll: entry.startingBankroll,
      score: signedMoneyToString(score),
      positions: account.positions,
    };
  }
}

export class TournamentReadService {
  constructor(private readonly db: Database) {}

  async list(
    pagination: Pagination,
    filters: { status?: string; search?: string },
    userId?: string,
  ) {
    const conditions = [
      filters.status
        ? eq(tournaments.status, filters.status as typeof tournaments.$inferSelect.status)
        : undefined,
      filters.search
        ? or(
            ilike(tournaments.name, `%${filters.search}%`),
            ilike(tournaments.slug, `%${filters.search}%`),
          )
        : undefined,
    ].filter((condition) => condition !== undefined);
    const where = conditions.length ? and(...conditions) : undefined;
    const [{ total }] = await this.db.select({ total: count() }).from(tournaments).where(where);
    const rows = await this.db
      .select({
        tournament: tournaments,
        totalEntries: count(tournamentEntries.id),
      })
      .from(tournaments)
      .leftJoin(tournamentEntries, eq(tournamentEntries.tournamentId, tournaments.id))
      .where(where)
      .groupBy(tournaments.id)
      .orderBy(desc(tournaments.createdAt), asc(tournaments.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize);

    const entryCounts = userId
      ? await this.db
          .select({ tournamentId: tournamentEntries.tournamentId, value: count() })
          .from(tournamentEntries)
          .where(eq(tournamentEntries.userId, userId))
          .groupBy(tournamentEntries.tournamentId)
      : [];
    const counts = new Map(entryCounts.map((row) => [row.tournamentId, Number(row.value)]));
    return {
      data: rows.map(({ tournament, totalEntries }) =>
        this.publicTournament(
          tournament,
          Number(totalEntries),
          userId ? (counts.get(tournament.id) ?? 0) : null,
        ),
      ),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }

  async detail(identifier: string, userId?: string) {
    const [row] = await this.db
      .select({ tournament: tournaments, totalEntries: count(tournamentEntries.id) })
      .from(tournaments)
      .leftJoin(tournamentEntries, eq(tournamentEntries.tournamentId, tournaments.id))
      .where(or(eq(tournaments.id, identifier), eq(tournaments.slug, identifier)))
      .groupBy(tournaments.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Tournament does not exist.');
    let userEntryCount: number | null = null;
    if (userId) {
      const [owned] = await this.db
        .select({ value: count() })
        .from(tournamentEntries)
        .where(
          and(
            eq(tournamentEntries.tournamentId, row.tournament.id),
            eq(tournamentEntries.userId, userId),
          ),
        );
      userEntryCount = Number(owned.value);
    }
    return this.publicTournament(row.tournament, Number(row.totalEntries), userEntryCount);
  }

  private publicTournament(
    tournament: typeof tournaments.$inferSelect,
    totalEntries: number,
    userEntryCount: number | null,
  ) {
    const now = Date.now();
    const eligible =
      userEntryCount === null
        ? null
        : tournament.status === 'OPEN' &&
          (!tournament.entryClosesAt || tournament.entryClosesAt.getTime() > now) &&
          userEntryCount < tournament.maxEntriesPerUser;
    return {
      id: tournament.id,
      slug: tournament.slug,
      name: tournament.name,
      description: tournament.description,
      status: tournament.status,
      simulatedPool: tournament.simulatedPool,
      entryContribution: tournament.simulatedEntryContribution,
      opensAt: tournament.opensAt,
      entryClosesAt: tournament.entryClosesAt,
      tradingClosesAt: tournament.tradingClosesAt,
      allowedSymbols: SUPPORTED_SYMBOLS,
      totalEntries,
      eligibleToEnter: eligible,
    };
  }
}

export type LeaderboardRow = {
  rank: number;
  entryId: string;
  displayName: string;
  sequenceNumber: number;
  score: string;
  percentageReturn: string;
  startingBankroll: string;
  equity: string;
  createdAt: string;
};

export class LeaderboardService {
  constructor(
    private readonly db: Database,
    private readonly snapshots: AccountSnapshotService,
    private readonly store: KeyValueStore,
    private readonly events: EventPublisher,
  ) {}

  key(tournamentId: string): string {
    return `projection:tournament:${tournamentId}:leaderboard:v1`;
  }

  async rebuild(tournamentId: string): Promise<LeaderboardRow[]> {
    const entries = await this.db
      .select({ entry: tournamentEntries, displayName: users.displayName })
      .from(tournamentEntries)
      .innerJoin(users, eq(users.id, tournamentEntries.userId))
      .where(eq(tournamentEntries.tournamentId, tournamentId));
    const exact = await Promise.all(
      entries.map(async ({ entry, displayName }) => {
        const snapshot = await this.snapshots.get(entry.id);
        const score = parseMoney(snapshot.equity) - parseMoney(entry.startingBankroll);
        const percentageHundredths = divideRoundHalfUp(
          score * 10_000n,
          parseMoney(entry.startingBankroll),
        );
        return {
          entryId: entry.id,
          displayName,
          sequenceNumber: entry.sequenceNumber,
          scoreMinor: score,
          score: signedMoneyToString(moneyFromMinorUnits(score)),
          percentageReturn: signedMoneyToString(moneyFromMinorUnits(percentageHundredths)),
          startingBankroll: entry.startingBankroll,
          equity: snapshot.equity,
          createdAt: entry.createdAt.toISOString(),
        };
      }),
    );
    exact.sort((left, right) => {
      if (left.scoreMinor !== right.scoreMinor) return left.scoreMinor > right.scoreMinor ? -1 : 1;
      const created = left.createdAt.localeCompare(right.createdAt);
      return created || left.entryId.localeCompare(right.entryId);
    });
    const ranked: LeaderboardRow[] = exact.map((row, index) => ({
      rank: index + 1,
      entryId: row.entryId,
      displayName: row.displayName,
      sequenceNumber: row.sequenceNumber,
      score: row.score,
      percentageReturn: row.percentageReturn,
      startingBankroll: row.startingBankroll,
      equity: row.equity,
      createdAt: row.createdAt,
    }));
    await this.store.set(this.key(tournamentId), JSON.stringify(ranked));
    return ranked;
  }

  async rows(tournamentId: string): Promise<LeaderboardRow[]> {
    const cached = await this.store.get(this.key(tournamentId));
    if (!cached) return this.rebuild(tournamentId);
    try {
      return JSON.parse(cached) as LeaderboardRow[];
    } catch {
      return this.rebuild(tournamentId);
    }
  }

  async page(tournamentId: string, pagination: Pagination, userId?: string) {
    const [tournament] = await this.db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    if (!tournament) throw new ApiError(404, 'NOT_FOUND', 'Tournament does not exist.');
    const rows = await this.rows(tournamentId);
    let myRanks: LeaderboardRow[] = [];
    if (userId) {
      const owned = await this.db
        .select({ id: tournamentEntries.id })
        .from(tournamentEntries)
        .where(
          and(
            eq(tournamentEntries.tournamentId, tournamentId),
            eq(tournamentEntries.userId, userId),
          ),
        );
      const ids = new Set(owned.map((entry) => entry.id));
      myRanks = rows.filter((row) => ids.has(row.entryId));
    }
    const start = (pagination.page - 1) * pagination.pageSize;
    return {
      data: rows.slice(start, start + pagination.pageSize),
      pagination: pageMetadata(pagination.page, pagination.pageSize, rows.length),
      myRanks,
    };
  }

  async refreshEntry(tournamentId: string, entryId: string): Promise<void> {
    await this.rebuild(tournamentId);
    this.events.publish(`tournament:${tournamentId}`, {
      type: 'leaderboard.updated',
      tournamentId,
      updatedEntryIds: [entryId],
    });
  }

  async refreshSymbol(symbol: MarketSymbol): Promise<void> {
    const affected = await this.db
      .selectDistinct({
        tournamentId: tournamentEntries.tournamentId,
        entryId: tournamentEntries.id,
      })
      .from(positions)
      .innerJoin(tournamentEntries, eq(tournamentEntries.id, positions.entryId))
      .where(and(eq(positions.symbol, symbol), sql`${positions.quantity} > 0`));
    const byTournament = new Map<string, string[]>();
    for (const { tournamentId, entryId } of affected)
      byTournament.set(tournamentId, [...(byTournament.get(tournamentId) ?? []), entryId]);
    for (const [tournamentId, entryIds] of byTournament) {
      await this.rebuild(tournamentId);
      this.events.publish(`tournament:${tournamentId}`, {
        type: 'leaderboard.updated',
        tournamentId,
        updatedEntryIds: entryIds,
      });
      for (const entryId of entryIds) {
        const snapshot = await this.snapshots.get(entryId);
        this.events.publish(`entry:${entryId}`, {
          type: 'entry.account_updated',
          entryId,
          cash: snapshot.cash,
          realizedPnL: snapshot.realizedPnL,
          unrealizedPnL: snapshot.unrealizedPnL,
          equity: snapshot.equity,
          score: snapshot.score,
        });
      }
    }
  }
}

export class TradingApiService {
  constructor(
    private readonly db: Database,
    private readonly market: MarketPriceProvider,
    private readonly snapshots: AccountSnapshotService,
    private readonly leaderboards: LeaderboardService,
    private readonly events: EventPublisher,
  ) {}

  async createEntry(tournamentId: string, userId: string) {
    const entry = await createTournamentEntry(this.db, tournamentId, userId);
    const [{ value: totalEntries }] = await this.db
      .select({ value: count() })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, tournamentId));
    await this.leaderboards.refreshEntry(tournamentId, entry.id);
    this.events.publish(`tournament:${tournamentId}`, {
      type: 'tournament.pool_updated',
      tournamentId,
      simulatedPool: entry.updatedPool,
      totalEntries: Number(totalEntries),
    });
    return {
      id: entry.id,
      sequenceNumber: entry.sequenceNumber,
      startingBankroll: entry.startingBankroll,
      cash: entry.cash,
      equity: entry.currentEquity,
      tournamentPool: entry.updatedPool,
      createdAt: entry.createdAt,
    };
  }

  async execute(request: MarketOrderRequest) {
    const result = await executeMarketOrder(this.db, this.market, request);
    const [entry] = await this.db
      .select({ tournamentId: tournamentEntries.tournamentId })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, request.entryId));
    const snapshot = await this.snapshots.get(request.entryId);
    if (!result.replayed) {
      if (entry) await this.leaderboards.refreshEntry(entry.tournamentId, request.entryId);
      this.events.publish(`entry:${request.entryId}`, {
        type: 'entry.account_updated',
        entryId: request.entryId,
        cash: snapshot.cash,
        realizedPnL: snapshot.realizedPnL,
        unrealizedPnL: snapshot.unrealizedPnL,
        equity: snapshot.equity,
        score: snapshot.score,
      });
    }
    return { ...result, account: snapshot };
  }
}

export class EntryReadService {
  constructor(
    private readonly db: Database,
    private readonly snapshots: AccountSnapshotService,
    private readonly leaderboards: LeaderboardService,
  ) {}

  async mine(
    userId: string,
    pagination: Pagination,
    filters: { tournamentId?: string; status?: string },
  ) {
    const conditions = [eq(tournamentEntries.userId, userId)];
    if (filters.tournamentId)
      conditions.push(eq(tournamentEntries.tournamentId, filters.tournamentId));
    if (filters.status)
      conditions.push(
        eq(tournaments.status, filters.status as typeof tournaments.$inferSelect.status),
      );
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(tournamentEntries)
      .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
      .where(and(...conditions));
    const rows = await this.db
      .select({ entry: tournamentEntries, tournament: tournaments })
      .from(tournamentEntries)
      .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
      .where(and(...conditions))
      .orderBy(desc(tournamentEntries.createdAt), asc(tournamentEntries.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize);
    return {
      data: rows.map(({ entry, tournament }) => ({
        id: entry.id,
        sequenceNumber: entry.sequenceNumber,
        startingBankroll: entry.startingBankroll,
        cash: entry.cash,
        equity: entry.currentEquity,
        createdAt: entry.createdAt,
        tournament: {
          id: tournament.id,
          slug: tournament.slug,
          name: tournament.name,
          status: tournament.status,
        },
      })),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }

  async detail(entryId: string) {
    const [row] = await this.db
      .select({ entry: tournamentEntries, tournament: tournaments })
      .from(tournamentEntries)
      .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
      .where(eq(tournamentEntries.id, entryId));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Tournament entry does not exist.');
    const snapshot = await this.snapshots.get(entryId);
    const rank = (await this.leaderboards.rows(row.entry.tournamentId)).find(
      (leaderboardRow) => leaderboardRow.entryId === entryId,
    )?.rank;
    return {
      id: row.entry.id,
      tournament: {
        id: row.tournament.id,
        slug: row.tournament.slug,
        name: row.tournament.name,
        status: row.tournament.status,
      },
      sequenceNumber: row.entry.sequenceNumber,
      startingBankroll: row.entry.startingBankroll,
      cash: snapshot.cash,
      realizedPnL: snapshot.realizedPnL,
      unrealizedPnL: snapshot.unrealizedPnL,
      equity: snapshot.equity,
      score: snapshot.score,
      rank: rank ?? null,
      createdAt: row.entry.createdAt,
    };
  }

  async positions(entryId: string) {
    return (await this.snapshots.get(entryId)).positions;
  }

  async history(entryId: string, pagination: Pagination) {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(orders)
      .where(eq(orders.entryId, entryId));
    const rows = await this.db
      .select({ order: orders, fill: fills })
      .from(orders)
      .leftJoin(fills, eq(fills.orderId, orders.id))
      .where(eq(orders.entryId, entryId))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize);
    return {
      data: rows.map(({ order, fill }) => ({
        id: order.id,
        status: order.status,
        symbol: order.symbol,
        side: order.side,
        requestedNotional: order.requestedNotional,
        requestedQuantity: order.requestedQuantity,
        requestedPercentageBps: order.requestedPercentageBps,
        createdAt: order.createdAt,
        fill: fill
          ? {
              id: fill.id,
              timestamp: fill.serverTimestamp,
              referencePrice: fill.referencePrice,
              fillPrice: fill.fillPrice,
              quantity: fill.quantity,
              notional: fill.notional,
              spread: fill.spreadAmount,
              slippage: fill.slippageAmount,
              fee: fill.feeAmount,
            }
          : null,
      })),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }
}
