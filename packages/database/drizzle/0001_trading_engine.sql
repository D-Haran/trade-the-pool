DO $$ BEGIN CREATE TYPE "trading_symbol" AS ENUM ('BTC-USD', 'ETH-USD', 'SOL-USD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "order_side" AS ENUM ('BUY', 'SELL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "order_type" AS ENUM ('MARKET'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "order_status" AS ENUM ('PENDING', 'FILLED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ledger_entry_type" AS ENUM ('ACCOUNT_INITIALIZED', 'TRADE_CASH_DEBIT', 'TRADE_CASH_CREDIT', 'TRADING_FEE', 'ADJUSTMENT', 'FINAL_SETTLEMENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_id" uuid NOT NULL REFERENCES "tournament_entries"("id"),
  "symbol" "trading_symbol" NOT NULL,
  "side" "order_side" NOT NULL,
  "order_type" "order_type" NOT NULL DEFAULT 'MARKET',
  "requested_notional" numeric(20,2),
  "requested_quantity" numeric(28,8),
  "requested_percentage_bps" integer,
  "status" "order_status" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "orders_requested_notional_positive" CHECK (requested_notional IS NULL OR requested_notional > 0),
  CONSTRAINT "orders_requested_quantity_positive" CHECK (requested_quantity IS NULL OR requested_quantity > 0),
  CONSTRAINT "orders_requested_percentage_valid" CHECK (requested_percentage_bps IS NULL OR (requested_percentage_bps > 0 AND requested_percentage_bps <= 10000)),
  CONSTRAINT "orders_request_shape_valid" CHECK ((side = 'BUY' AND requested_notional IS NOT NULL AND requested_quantity IS NULL AND requested_percentage_bps IS NULL) OR (side = 'SELL' AND requested_notional IS NULL AND ((requested_quantity IS NOT NULL)::int + (requested_percentage_bps IS NOT NULL)::int) = 1))
);
DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "orders_request_shape_valid" CHECK ((side = 'BUY' AND requested_notional IS NOT NULL AND requested_quantity IS NULL AND requested_percentage_bps IS NULL) OR (side = 'SELL' AND requested_notional IS NULL AND ((requested_quantity IS NOT NULL)::int + (requested_percentage_bps IS NOT NULL)::int) = 1)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "orders_entry_idempotency_idx" ON "orders" ("entry_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "fills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "orders"("id"),
  "entry_id" uuid NOT NULL REFERENCES "tournament_entries"("id"),
  "execution_sequence" integer NOT NULL CHECK (execution_sequence > 0),
  "symbol" "trading_symbol" NOT NULL,
  "side" "order_side" NOT NULL,
  "reference_price" numeric(28,8) NOT NULL CHECK (reference_price > 0),
  "fill_price" numeric(28,8) NOT NULL CHECK (fill_price > 0),
  "quantity" numeric(28,8) NOT NULL CHECK (quantity > 0),
  "notional" numeric(20,2) NOT NULL CHECK (notional >= 0),
  "spread_amount" numeric(28,8) NOT NULL CHECK (spread_amount >= 0),
  "slippage_amount" numeric(28,8) NOT NULL CHECK (slippage_amount >= 0),
  "fee_amount" numeric(20,2) NOT NULL CHECK (fee_amount >= 0),
  "market_source" varchar(64) NOT NULL,
  "market_timestamp" timestamptz NOT NULL,
  "server_timestamp" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "execution_sequence" integer;
ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "market_source" varchar(64);
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY entry_id ORDER BY created_at, id) AS sequence
  FROM fills WHERE execution_sequence IS NULL
)
UPDATE fills SET execution_sequence = ranked.sequence FROM ranked WHERE fills.id = ranked.id;
UPDATE fills SET market_source = 'legacy-unknown' WHERE market_source IS NULL;
ALTER TABLE "fills" ALTER COLUMN "execution_sequence" SET NOT NULL;
ALTER TABLE "fills" ALTER COLUMN "market_source" SET NOT NULL;
DO $$ BEGIN ALTER TABLE "fills" ADD CONSTRAINT "fills_execution_sequence_positive" CHECK (execution_sequence > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "fills_order_idx" ON "fills" ("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "fills_entry_sequence_idx" ON "fills" ("entry_id", "execution_sequence");

CREATE TABLE IF NOT EXISTS "positions" (
  "entry_id" uuid NOT NULL REFERENCES "tournament_entries"("id"),
  "symbol" "trading_symbol" NOT NULL,
  "quantity" numeric(28,8) NOT NULL CHECK (quantity >= 0),
  "average_entry_price" numeric(28,8) NOT NULL CHECK (average_entry_price >= 0),
  "realized_pnl" numeric(20,2) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("entry_id", "symbol"),
  CONSTRAINT "positions_quantity_average_price_consistent" CHECK ((quantity = 0 AND average_entry_price = 0) OR (quantity > 0 AND average_entry_price > 0))
);
DO $$ BEGIN ALTER TABLE "positions" ADD CONSTRAINT "positions_quantity_average_price_consistent" CHECK ((quantity = 0 AND average_entry_price = 0) OR (quantity > 0 AND average_entry_price > 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "account_ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entry_id" uuid NOT NULL REFERENCES "tournament_entries"("id"),
  "type" "ledger_entry_type" NOT NULL,
  "amount" numeric(20,2) NOT NULL,
  "reference_type" varchar(64) NOT NULL,
  "reference_id" varchar(128) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_ledger_amount_sign_valid" CHECK ((type = 'ACCOUNT_INITIALIZED' AND amount > 0) OR (type IN ('TRADE_CASH_DEBIT', 'TRADING_FEE') AND amount <= 0) OR (type = 'TRADE_CASH_CREDIT' AND amount >= 0) OR type IN ('ADJUSTMENT', 'FINAL_SETTLEMENT'))
);
DO $$ BEGIN ALTER TABLE "account_ledger_entries" ADD CONSTRAINT "account_ledger_amount_sign_valid" CHECK ((type = 'ACCOUNT_INITIALIZED' AND amount > 0) OR (type IN ('TRADE_CASH_DEBIT', 'TRADING_FEE') AND amount <= 0) OR (type = 'TRADE_CASH_CREDIT' AND amount >= 0) OR type IN ('ADJUSTMENT', 'FINAL_SETTLEMENT')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "account_ledger_reference_idx" ON "account_ledger_entries" ("entry_id", "type", "reference_type", "reference_id");

-- Existing foundation entries are initialized exactly once so reconciliation starts from a complete ledger.
INSERT INTO "account_ledger_entries" ("entry_id", "type", "amount", "reference_type", "reference_id", "metadata", "created_at")
SELECT e."id", 'ACCOUNT_INITIALIZED', e."starting_bankroll", 'TOURNAMENT_ENTRY', e."id"::text,
       jsonb_build_object('tournamentId', e."tournament_id", 'startingBankroll', e."starting_bankroll"), e."created_at"
FROM "tournament_entries" e
ON CONFLICT ("entry_id", "type", "reference_type", "reference_id") DO NOTHING;
