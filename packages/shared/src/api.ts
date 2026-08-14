import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const moneyStringSchema = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const signedMoneyStringSchema = z.string().regex(/^-?\d+(?:\.\d{1,2})?$/);
export const decimalStringSchema = z.string().regex(/^\d+(?:\.\d{1,8})?$/);
export const marketSymbolSchema = z.enum(['BTC-USD', 'ETH-USD', 'SOL-USD']);

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

export const tournamentPoolUpdatedEventSchema = z.object({
  type: z.literal('tournament.pool_updated'),
  tournamentId: uuidSchema,
  simulatedPool: z.string(),
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
  tournamentPoolUpdatedEventSchema,
  tournamentStatusChangedEventSchema,
  entryAccountUpdatedEventSchema,
  leaderboardUpdatedEventSchema,
]);

export type OrderRequestDto = z.infer<typeof orderRequestSchema>;
export type RealtimeSubscription = z.infer<typeof realtimeSubscriptionSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

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
