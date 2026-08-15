import { relations, sql } from 'drizzle-orm';
import {
  check,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from 'drizzle-orm/pg-core';

export const tournamentStatus = pgEnum('tournament_status', [
  'DRAFT',
  'REGISTRATION_OPEN',
  'TRADING_ACTIVE',
  'ENTRY_CLOSED',
  'TRADING_CLOSED',
  'FINALIZING',
  'COMPLETED',
  'CANCELLED',
]);
export const tradingSymbol = pgEnum('trading_symbol', [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'DOGE-USD',
  'LINK-USD',
  'AVAX-USD',
  'ADA-USD',
  'SUI-USD',
  'AAVE-USD',
  'NEAR-USD',
  'LTC-USD',
]);
export const orderSide = pgEnum('order_side', ['BUY', 'SELL']);
export const positionSide = pgEnum('position_side', ['LONG', 'SHORT']);
export const orderIntent = pgEnum('order_intent', ['OPEN', 'CLOSE']);
export const orderType = pgEnum('order_type', [
  'MARKET',
  'LIMIT',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'STOP_LOSS',
  'LIQUIDATION',
]);
export const orderStatus = pgEnum('order_status', [
  'PENDING',
  'OPEN',
  'TRIGGERED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
]);
export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'ACCOUNT_INITIALIZED',
  'TRADE_CASH_DEBIT',
  'TRADE_CASH_CREDIT',
  'TRADING_FEE',
  'ADJUSTMENT',
  'FINAL_SETTLEMENT',
]);
export const walletChain = pgEnum('wallet_chain', ['SOLANA']);
export const walletNetwork = pgEnum('wallet_network', [
  'mainnet-beta',
  'devnet',
  'testnet',
  'localnet',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  displayName: varchar('display_name', { length: 120 }).notNull(),
  ...timestamps,
});

export const userWallets = pgTable(
  'user_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    address: varchar('address', { length: 44 }).notNull(),
    chain: walletChain('chain').notNull().default('SOLANA'),
    network: walletNetwork('network').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('user_wallets_address_idx').on(table.address),
    uniqueIndex('user_wallets_one_primary_per_user_idx')
      .on(table.userId)
      .where(sql`${table.isPrimary} = true`),
    check(
      'user_wallets_solana_address_format',
      sql`${table.address} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`,
    ),
  ],
);

export const tournaments = pgTable(
  'tournaments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description').notNull(),
    status: tournamentStatus('status').notNull().default('DRAFT'),
    baseBankroll: numeric('base_bankroll', { precision: 20, scale: 2 }).notNull(),
    currentPrizePool: numeric('current_prize_pool', { precision: 20, scale: 2 }).notNull(),
    registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }).notNull(),
    tradingStartsAt: timestamp('trading_starts_at', { withTimezone: true }).notNull(),
    entryClosesAt: timestamp('entry_closes_at', { withTimezone: true }).notNull(),
    tradingClosesAt: timestamp('trading_closes_at', { withTimezone: true }).notNull(),
    maxEntriesPerUser: integer('max_entries_per_user').notNull(),
    payoutConfig: jsonb('payout_config')
      .$type<{
        directPrizes: Array<{ position: number; basisPoints: number }>;
        additionalCashLine?: { percentileBasisPoints: number; allocationBasisPoints: number };
      }>()
      .notNull(),
    rakebackConfig: jsonb('rakeback_config').$type<{
      bands: Array<{ entryCount: number; rebateBasisPoints: number }>;
    } | null>(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tournaments_slug_idx').on(table.slug),
    check('tournaments_base_bankroll_nonnegative', sql`${table.baseBankroll} >= 0`),
    check('tournaments_current_prize_pool_nonnegative', sql`${table.currentPrizePool} >= 0`),
    check('tournaments_max_entries_positive', sql`${table.maxEntriesPerUser} > 0`),
    check(
      'tournaments_schedule_ordered',
      sql`${table.registrationOpensAt} <= ${table.tradingStartsAt} AND ${table.tradingStartsAt} < ${table.entryClosesAt} AND ${table.entryClosesAt} <= ${table.tradingClosesAt}`,
    ),
  ],
);

export const tournamentEntryFeeTiers = pgTable(
  'tournament_entry_fee_tiers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    ordinal: integer('ordinal').notNull(),
    minPrizePool: numeric('min_prize_pool', { precision: 20, scale: 2 }).notNull(),
    maxPrizePool: numeric('max_prize_pool', { precision: 20, scale: 2 }),
    entryFee: numeric('entry_fee', { precision: 20, scale: 2 }).notNull(),
    prizePoolContribution: numeric('prize_pool_contribution', {
      precision: 20,
      scale: 2,
    }).notNull(),
    platformFee: numeric('platform_fee', { precision: 20, scale: 2 }).notNull(),
    futureRewardAllocation: numeric('future_reward_allocation', {
      precision: 20,
      scale: 2,
    })
      .notNull()
      .default('0.00'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tournament_fee_tiers_ordinal_idx').on(table.tournamentId, table.ordinal),
    uniqueIndex('tournament_fee_tiers_min_pool_idx').on(table.tournamentId, table.minPrizePool),
    check('tournament_fee_tiers_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check('tournament_fee_tiers_min_nonnegative', sql`${table.minPrizePool} >= 0`),
    check(
      'tournament_fee_tiers_range_valid',
      sql`${table.maxPrizePool} IS NULL OR ${table.maxPrizePool} > ${table.minPrizePool}`,
    ),
    check(
      'tournament_fee_tiers_allocations_valid',
      sql`${table.entryFee} >= 0 AND ${table.prizePoolContribution} >= 0 AND ${table.platformFee} >= 0 AND ${table.futureRewardAllocation} >= 0 AND ${table.entryFee} = ${table.prizePoolContribution} + ${table.platformFee} + ${table.futureRewardAllocation}`,
    ),
  ],
);

export const tournamentEntries = pgTable(
  'tournament_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sequenceNumber: integer('sequence_number').notNull(),
    tournamentEntryNumber: integer('tournament_entry_number').notNull(),
    entryFee: numeric('entry_fee', { precision: 20, scale: 2 }).notNull(),
    prizePoolBeforeEntry: numeric('prize_pool_before_entry', {
      precision: 20,
      scale: 2,
    }).notNull(),
    prizePoolContribution: numeric('prize_pool_contribution', {
      precision: 20,
      scale: 2,
    }).notNull(),
    platformAllocation: numeric('platform_allocation', {
      precision: 20,
      scale: 2,
    }).notNull(),
    futureRewardAllocation: numeric('future_reward_allocation', {
      precision: 20,
      scale: 2,
    })
      .notNull()
      .default('0.00'),
    rakebackAmount: numeric('rakeback_amount', { precision: 20, scale: 2 })
      .notNull()
      .default('0.00'),
    baseBankrollSnapshot: numeric('base_bankroll_snapshot', {
      precision: 20,
      scale: 2,
    }).notNull(),
    startingBankroll: numeric('starting_bankroll', { precision: 20, scale: 2 }).notNull(),
    cash: numeric('cash', { precision: 20, scale: 2 }).notNull(),
    realizedPnL: numeric('realized_pnl', { precision: 20, scale: 2 }).notNull(),
    unrealizedPnL: numeric('unrealized_pnl', { precision: 20, scale: 2 }).notNull(),
    currentEquity: numeric('current_equity', { precision: 20, scale: 2 }).notNull(),
    isBusted: boolean('is_busted').notNull().default(false),
    bustedAt: timestamp('busted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tournament_entries_user_sequence_idx').on(
      table.tournamentId,
      table.userId,
      table.sequenceNumber,
    ),
    uniqueIndex('tournament_entries_tournament_number_idx').on(
      table.tournamentId,
      table.tournamentEntryNumber,
    ),
    check('tournament_entries_sequence_positive', sql`${table.sequenceNumber} > 0`),
    check(
      'tournament_entries_economics_nonnegative',
      sql`${table.tournamentEntryNumber} > 0 AND ${table.entryFee} >= 0 AND ${table.prizePoolBeforeEntry} >= 0 AND ${table.prizePoolContribution} >= 0 AND ${table.platformAllocation} >= 0 AND ${table.futureRewardAllocation} >= 0 AND ${table.rakebackAmount} >= 0 AND ${table.baseBankrollSnapshot} >= 0 AND ${table.startingBankroll} > 0`,
    ),
    check(
      'tournament_entries_bankroll_snapshot_valid',
      sql`${table.startingBankroll} = ${table.baseBankrollSnapshot} + ${table.prizePoolBeforeEntry}`,
    ),
    check(
      'tournament_entries_fee_snapshot_valid',
      sql`${table.entryFee} = ${table.prizePoolContribution} + ${table.platformAllocation} + ${table.futureRewardAllocation}`,
    ),
    check(
      'tournament_entries_rakeback_bounded',
      sql`${table.rakebackAmount} <= ${table.platformAllocation}`,
    ),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => tournamentEntries.id),
    symbol: tradingSymbol('symbol').notNull(),
    side: orderSide('side').notNull(),
    positionSide: positionSide('position_side').notNull().default('LONG'),
    intent: orderIntent('intent').notNull().default('OPEN'),
    orderType: orderType('order_type').notNull().default('MARKET'),
    leverage: integer('leverage').notNull().default(1),
    requestedNotional: numeric('requested_notional', { precision: 20, scale: 2 }),
    requestedQuantity: numeric('requested_quantity', { precision: 28, scale: 8 }),
    requestedPercentageBps: integer('requested_percentage_bps'),
    limitPrice: numeric('limit_price', { precision: 28, scale: 8 }),
    triggerPrice: numeric('trigger_price', { precision: 28, scale: 8 }),
    status: orderStatus('status').notNull().default('PENDING'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    parentOrderId: uuid('parent_order_id'),
    ocoGroupId: uuid('oco_group_id'),
    rejectionReason: varchar('rejection_reason', { length: 160 }),
    cancellationReason: varchar('cancellation_reason', { length: 160 }),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
    filledAt: timestamp('filled_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('orders_entry_idempotency_idx').on(table.entryId, table.idempotencyKey),
    check(
      'orders_requested_notional_positive',
      sql`${table.requestedNotional} IS NULL OR ${table.requestedNotional} > 0`,
    ),
    check('orders_leverage_valid', sql`${table.leverage} >= 1 AND ${table.leverage} <= 5`),
    check(
      'orders_requested_quantity_positive',
      sql`${table.requestedQuantity} IS NULL OR ${table.requestedQuantity} > 0`,
    ),
    check(
      'orders_requested_percentage_valid',
      sql`${table.requestedPercentageBps} IS NULL OR (${table.requestedPercentageBps} > 0 AND ${table.requestedPercentageBps} <= 10000)`,
    ),
    check(
      'orders_request_shape_valid',
      sql`(${table.intent} = 'OPEN' AND ${table.requestedNotional} IS NOT NULL AND ${table.requestedQuantity} IS NULL AND ${table.requestedPercentageBps} IS NULL) OR (${table.intent} = 'CLOSE' AND ${table.requestedNotional} IS NULL AND ((${table.requestedQuantity} IS NOT NULL)::int + (${table.requestedPercentageBps} IS NOT NULL)::int) = 1)`,
    ),
    check(
      'orders_price_shape_valid',
      sql`(${table.orderType} IN ('MARKET', 'LIQUIDATION') AND ${table.limitPrice} IS NULL AND ${table.triggerPrice} IS NULL) OR (${table.orderType} = 'LIMIT' AND ${table.limitPrice} IS NOT NULL AND ${table.triggerPrice} IS NULL) OR (${table.orderType} IN ('STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS') AND ${table.limitPrice} IS NULL AND ${table.triggerPrice} IS NOT NULL)`,
    ),
  ],
);

export const fills = pgTable(
  'fills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => tournamentEntries.id),
    executionSequence: integer('execution_sequence').notNull(),
    symbol: tradingSymbol('symbol').notNull(),
    side: orderSide('side').notNull(),
    positionSide: positionSide('position_side').notNull().default('LONG'),
    intent: orderIntent('intent').notNull().default('OPEN'),
    leverage: integer('leverage').notNull().default(1),
    referencePrice: numeric('reference_price', { precision: 28, scale: 8 }).notNull(),
    fillPrice: numeric('fill_price', { precision: 28, scale: 8 }).notNull(),
    quantity: numeric('quantity', { precision: 28, scale: 8 }).notNull(),
    notional: numeric('notional', { precision: 20, scale: 2 }).notNull(),
    spreadAmount: numeric('spread_amount', { precision: 28, scale: 8 }).notNull(),
    slippageAmount: numeric('slippage_amount', { precision: 28, scale: 8 }).notNull(),
    feeAmount: numeric('fee_amount', { precision: 20, scale: 2 }).notNull(),
    realizedPnL: numeric('realized_pnl', { precision: 20, scale: 2 }).notNull().default('0.00'),
    marketSource: varchar('market_source', { length: 64 }).notNull(),
    marketTimestamp: timestamp('market_timestamp', { withTimezone: true }).notNull(),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fills_order_idx').on(table.orderId),
    uniqueIndex('fills_entry_sequence_idx').on(table.entryId, table.executionSequence),
    check('fills_execution_sequence_positive', sql`${table.executionSequence} > 0`),
    check('fills_leverage_valid', sql`${table.leverage} >= 1 AND ${table.leverage} <= 5`),
    check('fills_prices_positive', sql`${table.referencePrice} > 0 AND ${table.fillPrice} > 0`),
    check('fills_quantity_positive', sql`${table.quantity} > 0`),
    check(
      'fills_amounts_nonnegative',
      sql`${table.notional} >= 0 AND ${table.spreadAmount} >= 0 AND ${table.slippageAmount} >= 0 AND ${table.feeAmount} >= 0`,
    ),
  ],
);

export const positions = pgTable(
  'positions',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => tournamentEntries.id),
    symbol: tradingSymbol('symbol').notNull(),
    side: positionSide('side').notNull().default('LONG'),
    leverage: integer('leverage').notNull().default(1),
    quantity: numeric('quantity', { precision: 28, scale: 8 }).notNull(),
    averageEntryPrice: numeric('average_entry_price', { precision: 28, scale: 8 }).notNull(),
    realizedPnL: numeric('realized_pnl', { precision: 20, scale: 2 }).notNull(),
    marginUsed: numeric('margin_used', { precision: 20, scale: 2 }).notNull().default('0.00'),
    liquidationPrice: numeric('liquidation_price', { precision: 28, scale: 8 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.symbol] }),
    check('positions_quantity_nonnegative', sql`${table.quantity} >= 0`),
    check('positions_leverage_valid', sql`${table.leverage} >= 1 AND ${table.leverage} <= 5`),
    check('positions_margin_nonnegative', sql`${table.marginUsed} >= 0`),
    check('positions_average_price_nonnegative', sql`${table.averageEntryPrice} >= 0`),
    check(
      'positions_quantity_average_price_consistent',
      sql`(${table.quantity} = 0 AND ${table.averageEntryPrice} = 0) OR (${table.quantity} > 0 AND ${table.averageEntryPrice} > 0)`,
    ),
  ],
);

export const accountLedgerEntries = pgTable(
  'account_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => tournamentEntries.id),
    type: ledgerEntryType('type').notNull(),
    amount: numeric('amount', { precision: 20, scale: 2 }).notNull(),
    referenceType: varchar('reference_type', { length: 64 }).notNull(),
    referenceId: varchar('reference_id', { length: 128 }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('account_ledger_reference_idx').on(
      table.entryId,
      table.type,
      table.referenceType,
      table.referenceId,
    ),
    check(
      'account_ledger_amount_sign_valid',
      sql`(${table.type} = 'ACCOUNT_INITIALIZED' AND ${table.amount} > 0) OR (${table.type} IN ('TRADE_CASH_DEBIT', 'TRADING_FEE') AND ${table.amount} <= 0) OR (${table.type} = 'TRADE_CASH_CREDIT' AND ${table.amount} >= 0) OR ${table.type} IN ('ADJUSTMENT', 'FINAL_SETTLEMENT')`,
    ),
  ],
);

export const tournamentSettlementMarks = pgTable(
  'tournament_settlement_marks',
  {
    tournamentId: uuid('tournament_id')
      .notNull()
      .references(() => tournaments.id),
    symbol: tradingSymbol('symbol').notNull(),
    price: numeric('price', { precision: 28, scale: 8 }).notNull(),
    confidence: numeric('confidence', { precision: 28, scale: 8 }),
    source: varchar('source', { length: 64 }).notNull(),
    marketTimestamp: timestamp('market_timestamp', { withTimezone: true }).notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tournamentId, table.symbol] }),
    check('tournament_settlement_marks_price_positive', sql`${table.price} > 0`),
    check(
      'tournament_settlement_marks_confidence_nonnegative',
      sql`${table.confidence} IS NULL OR ${table.confidence} >= 0`,
    ),
  ],
);

export const tournamentRelations = relations(tournaments, ({ many }) => ({
  entries: many(tournamentEntries),
  feeTiers: many(tournamentEntryFeeTiers),
  settlementMarks: many(tournamentSettlementMarks),
}));
export const userRelations = relations(users, ({ many }) => ({
  entries: many(tournamentEntries),
  wallets: many(userWallets),
}));
export const userWalletRelations = relations(userWallets, ({ one }) => ({
  user: one(users, { fields: [userWallets.userId], references: [users.id] }),
}));
export const entryRelations = relations(tournamentEntries, ({ one }) => ({
  tournament: one(tournaments, {
    fields: [tournamentEntries.tournamentId],
    references: [tournaments.id],
  }),
  user: one(users, { fields: [tournamentEntries.userId], references: [users.id] }),
}));

export const schema = {
  users,
  userWallets,
  tournaments,
  tournamentEntries,
  orders,
  fills,
  positions,
  accountLedgerEntries,
  tournamentSettlementMarks,
  tournamentEntryFeeTiers,
};
