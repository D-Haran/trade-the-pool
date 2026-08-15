import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  fills,
  orders,
  positions,
  tournamentEntries,
  tournamentEntryFeeTiers,
  tournamentSettlementMarks,
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
  addMoney,
  divideRoundHalfUp,
  moneyFromMinorUnits,
  moneyToString,
  parseMoney,
  parsePrice,
  parseQuantity,
  parseSignedMoney,
  signedMoneyToString,
  uuidSchema,
  type RealtimeEvent,
} from '@trade-the-pool/shared';
import {
  cancelTradingOrder,
  createTournamentEntry,
  getAccountSummary,
  applicableEntryFeeTier,
  nextEntryFeeTier,
  projectPayouts,
  processConditionalOrders,
  processLiquidations,
  scheduledTournamentStatus,
  setPositionProtection,
  submitTradingOrder,
  type EntryFeeTier,
  type ProfessionalOrderResult,
  type TradingOrderRequest,
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
    let accountMarket = this.market;
    if (entry) {
      const [tournament] = await this.db
        .select({ status: tournaments.status })
        .from(tournaments)
        .where(eq(tournaments.id, entry.tournamentId));
      if (tournament && ['FINALIZING', 'COMPLETED'].includes(tournament.status)) {
        const settlementMarks = await this.db
          .select()
          .from(tournamentSettlementMarks)
          .where(eq(tournamentSettlementMarks.tournamentId, entry.tournamentId));
        if (settlementMarks.length === SUPPORTED_SYMBOLS.length) {
          const bySymbol = new Map(settlementMarks.map((mark) => [mark.symbol, mark]));
          accountMarket = {
            getSnapshot(symbol) {
              const mark = bySymbol.get(symbol);
              if (!mark) throw new Error(`Missing settlement mark for ${symbol}`);
              return {
                symbol,
                price: parsePrice(mark.price),
                marketTimestamp: mark.marketTimestamp,
                receivedAt: mark.lockedAt,
                source: `settlement:${mark.source}`,
                status: 'LIVE',
                executionEligible: false,
              };
            },
          };
        }
      }
    }
    const account = await getAccountSummary(this.db, accountMarket, entryId);
    const protectionRows = await this.db
      .select({
        symbol: orders.symbol,
        orderType: orders.orderType,
        triggerPrice: orders.triggerPrice,
      })
      .from(orders)
      .where(
        and(eq(orders.entryId, entryId), eq(orders.intent, 'CLOSE'), eq(orders.status, 'OPEN')),
      );
    const protections = new Map<
      MarketSymbol,
      { takeProfitPrice: string | null; stopLossPrice: string | null }
    >();
    for (const row of protectionRows) {
      const current = protections.get(row.symbol) ?? {
        takeProfitPrice: null,
        stopLossPrice: null,
      };
      if (row.orderType === 'TAKE_PROFIT') current.takeProfitPrice = row.triggerPrice;
      if (row.orderType === 'STOP_LOSS') current.stopLossPrice = row.triggerPrice;
      protections.set(row.symbol, current);
    }
    const score = moneyFromMinorUnits(
      parseSignedMoney(account.equity) - parseMoney(entry.startingBankroll),
    );
    const projectedPositions = account.positions.map((position) => {
      const quantity = parseQuantity(position.quantity);
      const costBasis = quantity === 0n ? moneyFromMinorUnits(0n) : parseMoney(position.marginUsed);
      const percentageHundredths =
        costBasis === 0n
          ? moneyFromMinorUnits(0n)
          : moneyFromMinorUnits(
              divideRoundHalfUp(parseSignedMoney(position.unrealizedPnL) * 10_000n, costBasis),
            );
      return {
        ...position,
        percentageReturn: signedMoneyToString(percentageHundredths),
        ...(protections.get(position.symbol) ?? {
          takeProfitPrice: null,
          stopLossPrice: null,
        }),
      };
    });
    return {
      ...account,
      startingBankroll: entry.startingBankroll,
      score: signedMoneyToString(score),
      positions: projectedPositions,
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
      data: await Promise.all(
        rows.map(({ tournament, totalEntries }) =>
          this.publicTournament(
            tournament,
            Number(totalEntries),
            userId ? (counts.get(tournament.id) ?? 0) : null,
          ),
        ),
      ),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }

  async detail(identifier: string, userId?: string) {
    const identifierCondition = uuidSchema.safeParse(identifier).success
      ? or(eq(tournaments.id, identifier), eq(tournaments.slug, identifier))
      : eq(tournaments.slug, identifier);
    const [row] = await this.db
      .select({ tournament: tournaments, totalEntries: count(tournamentEntries.id) })
      .from(tournaments)
      .leftJoin(tournamentEntries, eq(tournamentEntries.tournamentId, tournaments.id))
      .where(identifierCondition)
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

  private async publicTournament(
    tournament: typeof tournaments.$inferSelect,
    totalEntries: number,
    userEntryCount: number | null,
  ) {
    const now = new Date();
    const status = scheduledTournamentStatus(
      tournament.status,
      {
        registrationOpensAt: tournament.registrationOpensAt,
        tradingStartsAt: tournament.tradingStartsAt,
        entryClosesAt: tournament.entryClosesAt,
        tradingClosesAt: tournament.tradingClosesAt,
      },
      now,
    );
    const tierRows = await this.db
      .select()
      .from(tournamentEntryFeeTiers)
      .where(eq(tournamentEntryFeeTiers.tournamentId, tournament.id))
      .orderBy(asc(tournamentEntryFeeTiers.ordinal));
    const exactTiers: EntryFeeTier[] = tierRows.map((tier) => ({
      ordinal: tier.ordinal,
      minPrizePool: parseMoney(tier.minPrizePool),
      maxPrizePool: tier.maxPrizePool === null ? null : parseMoney(tier.maxPrizePool),
      entryFee: parseMoney(tier.entryFee),
      prizePoolContribution: parseMoney(tier.prizePoolContribution),
      platformFee: parseMoney(tier.platformFee),
      futureRewardAllocation: parseMoney(tier.futureRewardAllocation),
    }));
    const currentTier = applicableEntryFeeTier(exactTiers, parseMoney(tournament.currentPrizePool));
    const followingTier = nextEntryFeeTier(exactTiers, currentTier);
    const payout = projectPayouts(
      parseMoney(tournament.currentPrizePool),
      tournament.payoutConfig,
      totalEntries,
    );
    const eligible =
      userEntryCount === null
        ? null
        : (status === 'REGISTRATION_OPEN' || status === 'TRADING_ACTIVE') &&
          userEntryCount < tournament.maxEntriesPerUser;
    return {
      id: tournament.id,
      slug: tournament.slug,
      name: tournament.name,
      description: tournament.description,
      status,
      baseBankroll: tournament.baseBankroll,
      currentPrizePool: tournament.currentPrizePool,
      newEntryBankroll: moneyToString(
        addMoney(parseMoney(tournament.baseBankroll), parseMoney(tournament.currentPrizePool)),
      ),
      currentEntryPrice: moneyToString(currentTier.entryFee),
      prizePoolContribution: moneyToString(currentTier.prizePoolContribution),
      platformFee: moneyToString(currentTier.platformFee),
      futureRewardAllocation: moneyToString(currentTier.futureRewardAllocation),
      nextEntryPrice: followingTier
        ? {
            prizePoolThreshold: moneyToString(followingTier.minPrizePool),
            entryFee: moneyToString(followingTier.entryFee),
          }
        : null,
      feeTiers: exactTiers.map((tier) => ({
        ordinal: tier.ordinal,
        minPrizePool: moneyToString(tier.minPrizePool),
        maxPrizePool: tier.maxPrizePool === null ? null : moneyToString(tier.maxPrizePool),
        entryFee: moneyToString(tier.entryFee),
        prizePoolContribution: moneyToString(tier.prizePoolContribution),
        platformFee: moneyToString(tier.platformFee),
        futureRewardAllocation: moneyToString(tier.futureRewardAllocation),
      })),
      payoutProjection: {
        ...payout,
        prizes: payout.prizes.map((prize) => ({
          ...prize,
          amount: moneyToString(prize.amount),
        })),
        firstPrize: moneyToString(payout.firstPrize),
        secondPrize: moneyToString(payout.secondPrize),
        thirdPrize: moneyToString(payout.thirdPrize),
        distributableAmount: moneyToString(payout.distributableAmount),
        allocatedAmount: moneyToString(payout.allocatedAmount),
        unallocatedAmount: moneyToString(payout.unallocatedAmount),
      },
      registrationOpensAt: tournament.registrationOpensAt,
      tradingStartsAt: tournament.tradingStartsAt,
      entryClosesAt: tournament.entryClosesAt,
      tradingClosesAt: tournament.tradingClosesAt,
      allowedSymbols: SUPPORTED_SYMBOLS,
      totalEntries,
      maxEntriesPerUser: tournament.maxEntriesPerUser,
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
        const score = parseSignedMoney(snapshot.equity) - parseMoney(entry.startingBankroll);
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
  private readonly marketTickQueues = new Map<MarketSymbol, Promise<ProfessionalOrderResult[]>>();

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
      type: 'tournament.prize_pool_updated',
      tournamentId,
      currentPrizePool: entry.currentPrizePool,
      newEntryBankroll: entry.newEntryBankroll,
      currentEntryPrice: entry.currentEntryFee,
      totalEntries: Number(totalEntries),
    });
    return {
      id: entry.id,
      sequenceNumber: entry.sequenceNumber,
      tournamentEntryNumber: entry.tournamentEntryNumber,
      entryFee: entry.entryFee,
      prizePoolBeforeEntry: entry.prizePoolBeforeEntry,
      prizePoolContribution: entry.prizePoolContribution,
      platformAllocation: entry.platformAllocation,
      futureRewardAllocation: entry.futureRewardAllocation,
      rakebackAmount: entry.rakebackAmount,
      baseBankrollSnapshot: entry.baseBankrollSnapshot,
      startingBankroll: entry.startingBankroll,
      cash: entry.cash,
      equity: entry.currentEquity,
      currentPrizePool: entry.currentPrizePool,
      newEntryBankroll: entry.newEntryBankroll,
      createdAt: entry.createdAt,
    };
  }

  async execute(request: TradingOrderRequest) {
    const result = await submitTradingOrder(this.db, this.market, request);
    const [entry] = await this.db
      .select({ tournamentId: tournamentEntries.tournamentId })
      .from(tournamentEntries)
      .where(eq(tournamentEntries.id, request.entryId));
    const snapshot = await this.snapshots.get(request.entryId);
    if (!result.replayed && result.order.status === 'FILLED') {
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

  processMarketTick(symbol: MarketSymbol): Promise<ProfessionalOrderResult[]> {
    const prior = this.marketTickQueues.get(symbol) ?? Promise.resolve([]);
    const current = prior.catch(() => []).then(() => this.processMarketTickSerially(symbol));
    this.marketTickQueues.set(symbol, current);
    const release = () => {
      if (this.marketTickQueues.get(symbol) === current) this.marketTickQueues.delete(symbol);
    };
    void current.then(release, release);
    return current;
  }

  private async processMarketTickSerially(symbol: MarketSymbol) {
    const liquidations = await processLiquidations(this.db, this.market, symbol);
    const conditional = await processConditionalOrders(this.db, this.market, symbol);
    const results = [...liquidations, ...conditional];
    const openPositionEntries = await this.db
      .select({ entryId: positions.entryId })
      .from(positions)
      .where(and(eq(positions.symbol, symbol), sql`${positions.quantity} > 0`));
    const affectedEntryIds = new Set([
      ...results.map((result) => result.order.entryId),
      ...openPositionEntries.map((position) => position.entryId),
    ]);
    for (const entryId of affectedEntryIds) {
      const [entry] = await this.db
        .select({ tournamentId: tournamentEntries.tournamentId })
        .from(tournamentEntries)
        .where(eq(tournamentEntries.id, entryId));
      const snapshot = await this.snapshots.get(entryId);
      if (entry) await this.leaderboards.refreshEntry(entry.tournamentId, entryId);
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
    return results;
  }

  async cancel(entryId: string, orderId: string) {
    return cancelTradingOrder(this.db, entryId, orderId);
  }

  async protect(input: {
    entryId: string;
    symbol: string;
    takeProfitPrice: string | null;
    stopLossPrice: string | null;
    idempotencyKey: string;
  }) {
    return setPositionProtection(this.db, this.market, input);
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
    const tournamentIds = [...new Set(rows.map(({ tournament }) => tournament.id))];
    const rankings = new Map(
      await Promise.all(
        tournamentIds.map(
          async (tournamentId) =>
            [
              tournamentId,
              new Map(
                (await this.leaderboards.rows(tournamentId)).map((row) => [row.entryId, row.rank]),
              ),
            ] as const,
        ),
      ),
    );
    const data = await Promise.all(
      rows.map(async ({ entry, tournament }) => {
        const snapshot = await this.snapshots.get(entry.id);
        return {
          id: entry.id,
          sequenceNumber: entry.sequenceNumber,
          tournamentEntryNumber: entry.tournamentEntryNumber,
          entryFee: entry.entryFee,
          prizePoolBeforeEntry: entry.prizePoolBeforeEntry,
          prizePoolContribution: entry.prizePoolContribution,
          platformAllocation: entry.platformAllocation,
          futureRewardAllocation: entry.futureRewardAllocation,
          rakebackAmount: entry.rakebackAmount,
          baseBankrollSnapshot: entry.baseBankrollSnapshot,
          startingBankroll: entry.startingBankroll,
          cash: snapshot.cash,
          availableBuyingPower: snapshot.availableBuyingPower,
          availableMargin: snapshot.availableMargin,
          marginUsed: snapshot.marginUsed,
          positionValue: snapshot.positionValue,
          grossExposure: snapshot.grossExposure,
          realizedPnL: snapshot.realizedPnL,
          unrealizedPnL: snapshot.unrealizedPnL,
          equity: snapshot.equity,
          score: snapshot.score,
          percentageReturn: signedMoneyToString(
            moneyFromMinorUnits(
              divideRoundHalfUp(
                parseSignedMoney(snapshot.score) * 10_000n,
                parseMoney(entry.startingBankroll),
              ),
            ),
          ),
          rank: rankings.get(tournament.id)?.get(entry.id) ?? null,
          isBusted: entry.isBusted,
          bustedAt: entry.bustedAt,
          createdAt: entry.createdAt,
          tournament: {
            id: tournament.id,
            slug: tournament.slug,
            name: tournament.name,
            status: scheduledTournamentStatus(
              tournament.status,
              {
                registrationOpensAt: tournament.registrationOpensAt,
                tradingStartsAt: tournament.tradingStartsAt,
                entryClosesAt: tournament.entryClosesAt,
                tradingClosesAt: tournament.tradingClosesAt,
              },
              new Date(),
            ),
            registrationOpensAt: tournament.registrationOpensAt,
            tradingStartsAt: tournament.tradingStartsAt,
            entryClosesAt: tournament.entryClosesAt,
            tradingClosesAt: tournament.tradingClosesAt,
          },
        };
      }),
    );
    return {
      data,
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
        status: scheduledTournamentStatus(
          row.tournament.status,
          {
            registrationOpensAt: row.tournament.registrationOpensAt,
            tradingStartsAt: row.tournament.tradingStartsAt,
            entryClosesAt: row.tournament.entryClosesAt,
            tradingClosesAt: row.tournament.tradingClosesAt,
          },
          new Date(),
        ),
        registrationOpensAt: row.tournament.registrationOpensAt,
        tradingStartsAt: row.tournament.tradingStartsAt,
        entryClosesAt: row.tournament.entryClosesAt,
        tradingClosesAt: row.tournament.tradingClosesAt,
      },
      sequenceNumber: row.entry.sequenceNumber,
      tournamentEntryNumber: row.entry.tournamentEntryNumber,
      entryFee: row.entry.entryFee,
      prizePoolBeforeEntry: row.entry.prizePoolBeforeEntry,
      prizePoolContribution: row.entry.prizePoolContribution,
      platformAllocation: row.entry.platformAllocation,
      futureRewardAllocation: row.entry.futureRewardAllocation,
      rakebackAmount: row.entry.rakebackAmount,
      baseBankrollSnapshot: row.entry.baseBankrollSnapshot,
      startingBankroll: row.entry.startingBankroll,
      cash: snapshot.cash,
      availableBuyingPower: snapshot.availableBuyingPower,
      availableMargin: snapshot.availableMargin,
      marginUsed: snapshot.marginUsed,
      positionValue: snapshot.positionValue,
      grossExposure: snapshot.grossExposure,
      realizedPnL: snapshot.realizedPnL,
      unrealizedPnL: snapshot.unrealizedPnL,
      equity: snapshot.equity,
      score: snapshot.score,
      percentageReturn: signedMoneyToString(
        moneyFromMinorUnits(
          divideRoundHalfUp(
            parseSignedMoney(snapshot.score) * 10_000n,
            parseMoney(row.entry.startingBankroll),
          ),
        ),
      ),
      rank: rank ?? null,
      isBusted: row.entry.isBusted,
      bustedAt: row.entry.bustedAt,
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
        positionSide: order.positionSide,
        intent: order.intent,
        orderType: order.orderType,
        leverage: order.leverage,
        requestedNotional: order.requestedNotional,
        requestedQuantity: order.requestedQuantity,
        requestedPercentageBps: order.requestedPercentageBps,
        limitPrice: order.limitPrice,
        triggerPrice: order.triggerPrice,
        rejectionReason: order.rejectionReason,
        cancellationReason: order.cancellationReason,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
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
              realizedPnL: fill.realizedPnL,
              leverage: fill.leverage,
            }
          : null,
      })),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }

  async fills(entryId: string, pagination: Pagination) {
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(fills)
      .where(eq(fills.entryId, entryId));
    const rows = await this.db
      .select({ fill: fills, order: orders })
      .from(fills)
      .innerJoin(orders, eq(orders.id, fills.orderId))
      .where(eq(fills.entryId, entryId))
      .orderBy(desc(fills.executionSequence))
      .limit(pagination.pageSize)
      .offset((pagination.page - 1) * pagination.pageSize);
    return {
      data: rows.map(({ fill, order }) => ({
        id: fill.id,
        orderId: order.id,
        timestamp: fill.serverTimestamp,
        symbol: fill.symbol,
        side: fill.side,
        positionSide: fill.positionSide,
        intent: fill.intent,
        leverage: fill.leverage,
        referencePrice: fill.referencePrice,
        fillPrice: fill.fillPrice,
        quantity: fill.quantity,
        notional: fill.notional,
        spread: fill.spreadAmount,
        slippage: fill.slippageAmount,
        fee: fill.feeAmount,
        realizedPnL: fill.realizedPnL,
      })),
      pagination: pageMetadata(pagination.page, pagination.pageSize, Number(total)),
    };
  }

  async performance(entryId: string) {
    const snapshot = await this.snapshots.get(entryId);
    const closeFills = await this.db
      .select({ realizedPnL: fills.realizedPnL })
      .from(fills)
      .where(and(eq(fills.entryId, entryId), eq(fills.intent, 'CLOSE')));
    const realized = closeFills.map((fill) => parseSignedMoney(fill.realizedPnL));
    const winners = realized.filter((value) => value > 0n);
    const losers = realized.filter((value) => value < 0n);
    const winnerTotal = winners.reduce((sum, value) => sum + value, 0n);
    const loserTotal = losers.reduce((sum, value) => sum + -value, 0n);
    const average = (values: bigint[], total: bigint) =>
      values.length
        ? signedMoneyToString(moneyFromMinorUnits(total / BigInt(values.length)))
        : null;
    const ratio =
      loserTotal > 0n
        ? `${winnerTotal / loserTotal}.${(((winnerTotal % loserTotal) * 100n) / loserTotal)
            .toString()
            .padStart(2, '0')}`
        : null;
    return {
      currentPnL: snapshot.score,
      returnPercentage: signedMoneyToString(
        moneyFromMinorUnits(
          divideRoundHalfUp(
            parseSignedMoney(snapshot.score) * 10_000n,
            parseMoney(snapshot.startingBankroll),
          ),
        ),
      ),
      realizedPnL: snapshot.realizedPnL,
      unrealizedPnL: snapshot.unrealizedPnL,
      maxDrawdown: null,
      numberOfTrades: closeFills.length,
      winRatePercentage:
        closeFills.length > 0
          ? signedMoneyToString(
              moneyFromMinorUnits(
                divideRoundHalfUp(BigInt(winners.length) * 10_000n, BigInt(closeFills.length)),
              ),
            )
          : null,
      averageWinner: average(winners, winnerTotal),
      averageLoser: average(losers, -loserTotal),
      largestWinner: winners.length
        ? signedMoneyToString(
            moneyFromMinorUnits(winners.reduce((best, value) => (value > best ? value : best))),
          )
        : null,
      largestLoser: losers.length
        ? signedMoneyToString(
            moneyFromMinorUnits(losers.reduce((worst, value) => (value < worst ? value : worst))),
          )
        : null,
      profitFactor: ratio,
    };
  }
}
