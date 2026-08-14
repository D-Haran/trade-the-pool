import { relations } from 'drizzle-orm';
import {
  integer,
  numeric,
  pgEnum,
  pgTable,
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

export const schema = { users, tournaments, tournamentEntries };
