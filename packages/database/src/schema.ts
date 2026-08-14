import { relations, sql } from 'drizzle-orm';
import {
  check,
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
  'OPEN',
  'ENTRY_CLOSED',
  'TRADING_CLOSED',
  'FINALIZING',
  'COMPLETED',
  'CANCELLED',
]);
export const tradingSymbol = pgEnum('trading_symbol', ['BTC-USD', 'ETH-USD', 'SOL-USD']);
export const orderSide = pgEnum('order_side', ['BUY', 'SELL']);
export const orderType = pgEnum('order_type', ['MARKET']);
export const orderStatus = pgEnum('order_status', ['PENDING', 'FILLED', 'REJECTED']);
export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'ACCOUNT_INITIALIZED',
  'TRADE_CASH_DEBIT',
  'TRADE_CASH_CREDIT',
  'TRADING_FEE',
  'ADJUSTMENT',
  'FINAL_SETTLEMENT',
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

export const tournaments = pgTable(
  'tournaments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: varchar('slug', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description').notNull(),
    status: tournamentStatus('status').notNull().default('DRAFT'),
    simulatedPool: numeric('simulated_pool', { precision: 20, scale: 2 }).notNull(),
    simulatedEntryContribution: numeric('simulated_entry_contribution', {
      precision: 20,
      scale: 2,
    }).notNull(),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    entryClosesAt: timestamp('entry_closes_at', { withTimezone: true }),
    tradingClosesAt: timestamp('trading_closes_at', { withTimezone: true }),
    maxEntriesPerUser: integer('max_entries_per_user').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('tournaments_slug_idx').on(table.slug)],
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
    startingBankroll: numeric('starting_bankroll', { precision: 20, scale: 2 }).notNull(),
    cash: numeric('cash', { precision: 20, scale: 2 }).notNull(),
    realizedPnL: numeric('realized_pnl', { precision: 20, scale: 2 }).notNull(),
    unrealizedPnL: numeric('unrealized_pnl', { precision: 20, scale: 2 }).notNull(),
    currentEquity: numeric('current_equity', { precision: 20, scale: 2 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('tournament_entries_user_sequence_idx').on(
      table.tournamentId,
      table.userId,
      table.sequenceNumber,
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
    orderType: orderType('order_type').notNull().default('MARKET'),
    requestedNotional: numeric('requested_notional', { precision: 20, scale: 2 }),
    requestedQuantity: numeric('requested_quantity', { precision: 28, scale: 8 }),
    requestedPercentageBps: integer('requested_percentage_bps'),
    status: orderStatus('status').notNull().default('PENDING'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('orders_entry_idempotency_idx').on(table.entryId, table.idempotencyKey),
    check(
      'orders_requested_notional_positive',
      sql`${table.requestedNotional} IS NULL OR ${table.requestedNotional} > 0`,
    ),
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
      sql`(${table.side} = 'BUY' AND ${table.requestedNotional} IS NOT NULL AND ${table.requestedQuantity} IS NULL AND ${table.requestedPercentageBps} IS NULL) OR (${table.side} = 'SELL' AND ${table.requestedNotional} IS NULL AND ((${table.requestedQuantity} IS NOT NULL)::int + (${table.requestedPercentageBps} IS NOT NULL)::int) = 1)`,
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
    referencePrice: numeric('reference_price', { precision: 28, scale: 8 }).notNull(),
    fillPrice: numeric('fill_price', { precision: 28, scale: 8 }).notNull(),
    quantity: numeric('quantity', { precision: 28, scale: 8 }).notNull(),
    notional: numeric('notional', { precision: 20, scale: 2 }).notNull(),
    spreadAmount: numeric('spread_amount', { precision: 28, scale: 8 }).notNull(),
    slippageAmount: numeric('slippage_amount', { precision: 28, scale: 8 }).notNull(),
    feeAmount: numeric('fee_amount', { precision: 20, scale: 2 }).notNull(),
    marketSource: varchar('market_source', { length: 64 }).notNull(),
    marketTimestamp: timestamp('market_timestamp', { withTimezone: true }).notNull(),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('fills_order_idx').on(table.orderId),
    uniqueIndex('fills_entry_sequence_idx').on(table.entryId, table.executionSequence),
    check('fills_execution_sequence_positive', sql`${table.executionSequence} > 0`),
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
    quantity: numeric('quantity', { precision: 28, scale: 8 }).notNull(),
    averageEntryPrice: numeric('average_entry_price', { precision: 28, scale: 8 }).notNull(),
    realizedPnL: numeric('realized_pnl', { precision: 20, scale: 2 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.symbol] }),
    check('positions_quantity_nonnegative', sql`${table.quantity} >= 0`),
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

export const tournamentRelations = relations(tournaments, ({ many }) => ({
  entries: many(tournamentEntries),
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
  tournaments,
  tournamentEntries,
  orders,
  fills,
  positions,
  accountLedgerEntries,
};
