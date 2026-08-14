import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const moneyStringSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const signedMoneyStringSchema = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
export const decimalStringSchema = z.string().regex(/^\d+(?:\.\d{1,8})?$/);
export const marketSymbolSchema = z.enum(['BTC-USD', 'ETH-USD', 'SOL-USD']);
export const tournamentStatusSchema = z.enum([
  'DRAFT',
  'REGISTRATION_OPEN',
  'TRADING_ACTIVE',
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

export const legacyOrderRequestSchema = z.discriminatedUnion('side', [
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

export const positionSideSchema = z.enum(['LONG', 'SHORT']);
export const orderIntentSchema = z.enum(['OPEN', 'CLOSE']);
export const orderExecutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MARKET') }).strict(),
  z.object({ type: z.literal('LIMIT'), limitPrice: decimalStringSchema }).strict(),
  z.object({ type: z.literal('STOP_MARKET'), stopPrice: decimalStringSchema }).strict(),
]);
const optionalProtection = {
  takeProfitPrice: decimalStringSchema.nullable().optional(),
  stopLossPrice: decimalStringSchema.nullable().optional(),
};
export const professionalOrderRequestSchema = z.discriminatedUnion('intent', [
  z
    .object({
      ...orderBase,
      intent: z.literal('OPEN'),
      positionSide: positionSideSchema,
      notional: moneyStringSchema,
      execution: orderExecutionSchema,
      ...optionalProtection,
    })
    .strict(),
  z
    .object({
      ...orderBase,
      intent: z.literal('CLOSE'),
      positionSide: positionSideSchema,
      amount: z.discriminatedUnion('type', [
        z.object({ type: z.literal('QUANTITY'), quantity: decimalStringSchema }).strict(),
        z
          .object({
            type: z.literal('PERCENTAGE'),
            percentageBps: z.number().int().min(1).max(10_000),
          })
          .strict(),
      ]),
      execution: orderExecutionSchema,
    })
    .strict(),
]);
export const orderRequestSchema = z.union([
  professionalOrderRequestSchema,
  legacyOrderRequestSchema,
]);

export const positionProtectionRequestSchema = z
  .object({
    takeProfitPrice: decimalStringSchema.nullable(),
    stopLossPrice: decimalStringSchema.nullable(),
  })
  .strict();

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
  markPrice: z.string().nullable(),
  marketTimestamp: z.string().datetime(),
  markTimestamp: z.string().datetime().nullable(),
  source: z.string(),
  markSource: z.string().nullable(),
  status: z.enum(['LIVE', 'DELAYED', 'STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED']),
  exchangeStatus: z.enum(['LIVE', 'DELAYED', 'STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED']),
});

const orderBookLevelEventSchema = z.object({
  price: z.string(),
  quantity: z.string(),
  total: z.string(),
});
export const marketBookEventSchema = z.object({
  type: z.literal('market.book'),
  symbol: marketSymbolSchema,
  venue: z.string(),
  status: z.enum(['LIVE', 'DELAYED', 'STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED']),
  timestamp: z.string().datetime().nullable(),
  bids: z.array(orderBookLevelEventSchema).max(50),
  asks: z.array(orderBookLevelEventSchema).max(50),
  spread: z.string().nullable(),
  spreadBasisPoints: z.string().nullable(),
});
export const marketTradesEventSchema = z.object({
  type: z.literal('market.trades'),
  symbol: marketSymbolSchema,
  trades: z
    .array(
      z.object({
        id: z.string(),
        price: z.string(),
        quantity: z.string(),
        side: z.enum(['BUY', 'SELL']).nullable(),
        timestamp: z.string().datetime(),
        venue: z.string(),
      }),
    )
    .max(100),
});
export const marketCandleEventSchema = z.object({
  type: z.literal('market.candle'),
  symbol: marketSymbolSchema,
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  candle: z.object({
    timestamp: z.string().datetime(),
    open: z.string(),
    high: z.string(),
    low: z.string(),
    close: z.string(),
    volume: z.string().nullable(),
  }),
});
export const marketStatusEventSchema = z.object({
  type: z.literal('market.status'),
  symbol: marketSymbolSchema,
  status: z.enum(['LIVE', 'DELAYED', 'STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED']),
});

export const tournamentPrizePoolUpdatedEventSchema = z.object({
  type: z.literal('tournament.prize_pool_updated'),
  tournamentId: uuidSchema,
  currentPrizePool: z.string(),
  newEntryBankroll: z.string(),
  currentEntryPrice: z.string(),
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
  marketBookEventSchema,
  marketTradesEventSchema,
  marketCandleEventSchema,
  marketStatusEventSchema,
  tournamentPrizePoolUpdatedEventSchema,
  tournamentStatusChangedEventSchema,
  entryAccountUpdatedEventSchema,
  leaderboardUpdatedEventSchema,
]);

export type OrderRequestDto = z.infer<typeof orderRequestSchema>;
export type ProfessionalOrderRequestDto = z.infer<typeof professionalOrderRequestSchema>;
export type PositionProtectionRequestDto = z.infer<typeof positionProtectionRequestSchema>;
export type RealtimeSubscription = z.infer<typeof realtimeSubscriptionSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type MarketSymbolDto = z.infer<typeof marketSymbolSchema>;
export type TournamentStatusDto = z.infer<typeof tournamentStatusSchema>;

export type ApiEnvelope<T> = { data: T };

export type UserDto = { id: string; displayName: string };

export type SolanaClusterDto = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
export type WalletChallengePurposeDto = 'LOGIN' | 'LINK';

export type SolanaSignInInputDto = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: '1';
  chainId: `solana:${'mainnet' | 'devnet' | 'testnet' | 'localnet'}`;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  requestId: string;
};

export type WalletChallengeDto = {
  challengeId: string;
  purpose: WalletChallengePurposeDto;
  chain: 'SOLANA';
  network: SolanaClusterDto;
  input: SolanaSignInInputDto;
  message: string;
};

export type UserWalletDto = {
  id: string;
  address: string;
  chain: 'SOLANA';
  network: SolanaClusterDto;
  isPrimary: boolean;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TournamentFeeTierDto = {
  ordinal: number;
  minPrizePool: string;
  maxPrizePool: string | null;
  entryFee: string;
  prizePoolContribution: string;
  platformFee: string;
  futureRewardAllocation: string;
};

export type PayoutProjectionDto = {
  prizes: Array<{ position: number; amount: string; basisPoints: number | null }>;
  firstPrize: string;
  secondPrize: string;
  thirdPrize: string;
  cashLinePosition: number;
  paidEntries: number;
  paidEntriesPercentBasisPoints: number;
  distributableAmount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
};

export type TournamentDto = {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: TournamentStatusDto;
  baseBankroll: string;
  currentPrizePool: string;
  newEntryBankroll: string;
  currentEntryPrice: string;
  prizePoolContribution: string;
  platformFee: string;
  futureRewardAllocation: string;
  nextEntryPrice: { prizePoolThreshold: string; entryFee: string } | null;
  feeTiers: TournamentFeeTierDto[];
  payoutProjection: PayoutProjectionDto;
  registrationOpensAt: string;
  tradingStartsAt: string;
  entryClosesAt: string;
  tradingClosesAt: string;
  allowedSymbols: MarketSymbolDto[];
  totalEntries: number;
  maxEntriesPerUser: number;
  eligibleToEnter: boolean | null;
};

export type TournamentSummaryDto = Pick<
  TournamentDto,
  | 'id'
  | 'slug'
  | 'name'
  | 'status'
  | 'registrationOpensAt'
  | 'tradingStartsAt'
  | 'entryClosesAt'
  | 'tradingClosesAt'
>;

export type EntrySummaryDto = {
  id: string;
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
  availableBuyingPower: string;
  positionValue: string;
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
  side: 'LONG' | 'SHORT';
  quantity: string;
  averageEntryPrice: string;
  currentMark: string | null;
  marketValue: string;
  realizedPnL: string;
  unrealizedPnL: string;
  percentageReturn: string;
  takeProfitPrice: string | null;
  stopLossPrice: string | null;
};

export type OrderHistoryDto = {
  id: string;
  status: 'PENDING' | 'OPEN' | 'TRIGGERED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  symbol: MarketSymbolDto;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  intent: 'OPEN' | 'CLOSE';
  orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT' | 'STOP_LOSS';
  requestedNotional: string | null;
  requestedQuantity: string | null;
  requestedPercentageBps: number | null;
  limitPrice: string | null;
  triggerPrice: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
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
    realizedPnL: string;
  };
};

export type OrderResultDto = {
  orderId: string;
  fillId: string | null;
  status: 'OPEN' | 'FILLED';
  idempotentReplay: boolean;
  symbol: MarketSymbolDto;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  intent: 'OPEN' | 'CLOSE';
  orderType: 'MARKET' | 'LIMIT' | 'STOP_MARKET';
  requestedNotional: string | null;
  quantity: string | null;
  referencePrice: string | null;
  fillPrice: string | null;
  spread: string | null;
  slippage: string | null;
  fee: string | null;
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
  dataMode: 'fake' | 'live';
  price: string;
  markPrice: string | null;
  marketTimestamp: string;
  markTimestamp: string | null;
  source: string;
  markSource: string | null;
  status: 'LIVE' | 'DELAYED' | 'STALE' | 'RECONNECTING' | 'UNAVAILABLE' | 'DEGRADED';
  exchangeStatus: 'LIVE' | 'DELAYED' | 'STALE' | 'RECONNECTING' | 'UNAVAILABLE' | 'DEGRADED';
  availability: 'ACTIVE' | 'DEGRADED' | 'PAUSED' | 'DISABLED';
  deviationBasisPoints: string | null;
  change24hBasisPoints: string | null;
  high24h: string | null;
  low24h: string | null;
  volume24h: string | null;
  provenance: {
    currentPrice: string;
    statistics24h: string;
    historicalCandles: string;
    realtimeCandles: string;
    orderBook: string;
    recentTrades: string;
    authoritativeMark: string;
    comparisonPrice: string;
  };
  metadata: {
    assetClass: 'CRYPTO';
    baseCurrency: 'BTC' | 'ETH' | 'SOL';
    quoteCurrency: 'USD';
    tradingSchedule: '24/7';
    pricePrecision: number;
    quantityPrecision: number;
  };
};

export type CandleIntervalDto = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export type MarketCandleDto = {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
};

export type MarketOrderBookLevelDto = { price: string; quantity: string; total: string };
export type MarketOrderBookDto = {
  symbol: MarketSymbolDto;
  venue: string;
  status: MarketSnapshotDto['status'];
  timestamp: string | null;
  bids: MarketOrderBookLevelDto[];
  asks: MarketOrderBookLevelDto[];
  spread: string | null;
  spreadBasisPoints: string | null;
};

export type MarketTradeDto = {
  id: string;
  symbol: MarketSymbolDto;
  price: string;
  quantity: string;
  side: 'BUY' | 'SELL' | null;
  timestamp: string;
  venue: string;
};

export type FillHistoryDto = NonNullable<OrderHistoryDto['fill']> & {
  orderId: string;
  symbol: MarketSymbolDto;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  intent: 'OPEN' | 'CLOSE';
  realizedPnL: string;
};

export type PerformanceDto = {
  currentPnL: string;
  returnPercentage: string;
  realizedPnL: string;
  unrealizedPnL: string;
  maxDrawdown: string | null;
  numberOfTrades: number;
  winRatePercentage: string | null;
  averageWinner: string | null;
  averageLoser: string | null;
  largestWinner: string | null;
  largestLoser: string | null;
  profitFactor: string | null;
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
