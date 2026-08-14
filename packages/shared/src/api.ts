import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const moneyStringSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const signedMoneyStringSchema = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
export const decimalStringSchema = z.string().regex(/^\d+(?:\.\d{1,8})?$/);
export const marketSymbolSchema = z.enum(['BTC-USD', 'ETH-USD', 'SOL-USD']);
export const tournamentStatusSchema = z.enum([
  'DRAFT',
  'OPEN',
  'ENTRY_CLOSED',
  'TRADING_CLOSED',
  'FINALIZING',
  'COMPLETED',
  'CANCELLED',
]);

export const paginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const orderBase = {
  entryId: uuidSchema,
  symbol: marketSymbolSchema,
};

export const orderRequestSchema = z.discriminatedUnion('side', [
  z.object({ ...orderBase, side: z.literal('BUY'), notional: moneyStringSchema }).strict(),
  z
    .object({
      ...orderBase,
      side: z.literal('SELL'),
      amount: z.discriminatedUnion('type', [
        z.object({ type: z.literal('QUANTITY'), quantity: decimalStringSchema }).strict(),
        z
          .object({
            type: z.literal('PERCENTAGE'),
            percentageBps: z.number().int().min(1).max(10_000),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

export const realtimeSubscriptionSchema = z
  .object({
    action: z.enum(['subscribe', 'unsubscribe']),
    topic: z.string().regex(/^(market:[A-Z]+-USD|tournament:[0-9a-f-]+|entry:[0-9a-f-]+)$/),
  })
  .strict();

export const marketPriceEventSchema = z.object({
  type: z.literal('market.price'),
  symbol: marketSymbolSchema,
  price: z.string(),
  marketTimestamp: z.string().datetime(),
  source: z.string(),
});

export const tournamentPrizePoolUpdatedEventSchema = z.object({
  type: z.literal('tournament.prize_pool_updated'),
  tournamentId: uuidSchema,
  currentPrizePool: z.string(),
  newEntryBankroll: z.string(),
  totalEntries: z.number().int().nonnegative(),
});

export const tournamentStatusChangedEventSchema = z.object({
  type: z.literal('tournament.status_changed'),
  tournamentId: uuidSchema,
  status: z.string(),
});

export const entryAccountUpdatedEventSchema = z.object({
  type: z.literal('entry.account_updated'),
  entryId: uuidSchema,
  cash: z.string(),
  realizedPnL: z.string(),
  unrealizedPnL: z.string(),
  equity: z.string(),
  score: z.string(),
});

export const leaderboardUpdatedEventSchema = z.object({
  type: z.literal('leaderboard.updated'),
  tournamentId: uuidSchema,
  updatedEntryIds: z.array(uuidSchema).max(100),
});

export const realtimeEventSchema = z.discriminatedUnion('type', [
  marketPriceEventSchema,
  tournamentPrizePoolUpdatedEventSchema,
  tournamentStatusChangedEventSchema,
  entryAccountUpdatedEventSchema,
  leaderboardUpdatedEventSchema,
]);

export type OrderRequestDto = z.infer<typeof orderRequestSchema>;
export type RealtimeSubscription = z.infer<typeof realtimeSubscriptionSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type MarketSymbolDto = z.infer<typeof marketSymbolSchema>;
export type TournamentStatusDto = z.infer<typeof tournamentStatusSchema>;

export type ApiEnvelope<T> = { data: T };

export type UserDto = { id: string; displayName: string };

export type TournamentDto = {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: TournamentStatusDto;
  baseBankroll: string;
  currentPrizePool: string;
  newEntryBankroll: string;
  entryContribution: string;
  opensAt: string | null;
  entryClosesAt: string | null;
  tradingClosesAt: string | null;
  allowedSymbols: MarketSymbolDto[];
  totalEntries: number;
  maxEntriesPerUser: number;
  eligibleToEnter: boolean | null;
};

export type TournamentSummaryDto = Pick<
  TournamentDto,
  'id' | 'slug' | 'name' | 'status' | 'entryClosesAt' | 'tradingClosesAt'
>;

export type EntrySummaryDto = {
  id: string;
  sequenceNumber: number;
  startingBankroll: string;
  cash: string;
  realizedPnL: string;
  unrealizedPnL: string;
  equity: string;
  score: string;
  percentageReturn: string;
  rank: number | null;
  createdAt: string;
  tournament: TournamentSummaryDto;
};

export type EntryDetailDto = EntrySummaryDto;

export type PositionDto = {
  symbol: MarketSymbolDto;
  quantity: string;
  averageEntryPrice: string;
  currentMark: string | null;
  marketValue: string;
  realizedPnL: string;
  unrealizedPnL: string;
  percentageReturn: string;
};

export type OrderHistoryDto = {
  id: string;
  status: 'PENDING' | 'FILLED' | 'REJECTED';
  symbol: MarketSymbolDto;
  side: 'BUY' | 'SELL';
  requestedNotional: string | null;
  requestedQuantity: string | null;
  requestedPercentageBps: number | null;
  createdAt: string;
  fill: null | {
    id: string;
    timestamp: string;
    referencePrice: string;
    fillPrice: string;
    quantity: string;
    notional: string;
    spread: string;
    slippage: string;
    fee: string;
  };
};

export type OrderResultDto = {
  orderId: string;
  fillId: string;
  status: 'FILLED';
  idempotentReplay: boolean;
  symbol: MarketSymbolDto;
  side: 'BUY' | 'SELL';
  requestedNotional: string | null;
  quantity: string;
  referencePrice: string;
  fillPrice: string;
  spread: string;
  slippage: string;
  fee: string;
  resultingCash: string;
  realizedPnL: string;
  unrealizedPnL: string;
  equity: string;
};

export type LeaderboardRowDto = {
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

export type LeaderboardPageDto = Page<LeaderboardRowDto> & { myRanks: LeaderboardRowDto[] };

export type MarketSnapshotDto = {
  symbol: MarketSymbolDto;
  price: string;
  marketTimestamp: string;
  source: string;
};

export type CandleIntervalDto = '1m' | '5m' | '15m' | '1h';

export type MarketCandleDto = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
};

export type Page<T> = {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};
