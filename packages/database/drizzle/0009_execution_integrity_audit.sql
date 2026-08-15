DO $$ BEGIN
  CREATE TYPE "execution_reason" AS ENUM (
    'MANUAL_OPEN',
    'MANUAL_CLOSE',
    'LIMIT_TRIGGER',
    'STOP_TRIGGER',
    'TAKE_PROFIT',
    'STOP_LOSS',
    'LIQUIDATION',
    'TOURNAMENT_SETTLEMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "execution_reason" "execution_reason";
UPDATE "orders"
SET "execution_reason" = CASE
  WHEN "order_type" = 'LIQUIDATION' THEN 'LIQUIDATION'::"execution_reason"
  WHEN "order_type" = 'TAKE_PROFIT' THEN 'TAKE_PROFIT'::"execution_reason"
  WHEN "order_type" = 'STOP_LOSS' THEN 'STOP_LOSS'::"execution_reason"
  WHEN "order_type" = 'STOP_MARKET' THEN 'STOP_TRIGGER'::"execution_reason"
  WHEN "order_type" = 'LIMIT' THEN 'LIMIT_TRIGGER'::"execution_reason"
  WHEN "intent" = 'CLOSE' THEN 'MANUAL_CLOSE'::"execution_reason"
  ELSE 'MANUAL_OPEN'::"execution_reason"
END
WHERE "execution_reason" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "execution_reason" SET DEFAULT 'MANUAL_OPEN';
ALTER TABLE "orders" ALTER COLUMN "execution_reason" SET NOT NULL;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "attached_take_profit_price" numeric(28,8);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "attached_stop_loss_price" numeric(28,8);
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_attached_protection_valid" CHECK (
    ("attached_take_profit_price" IS NULL OR ("intent" = 'OPEN' AND "attached_take_profit_price" > 0)) AND
    ("attached_stop_loss_price" IS NULL OR ("intent" = 'OPEN' AND "attached_stop_loss_price" > 0))
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "execution_reason" "execution_reason";
UPDATE "fills" fill
SET "execution_reason" = orders."execution_reason"
FROM "orders" orders
WHERE orders."id" = fill."order_id" AND fill."execution_reason" IS NULL;
ALTER TABLE "fills" ALTER COLUMN "execution_reason" SET DEFAULT 'MANUAL_OPEN';
ALTER TABLE "fills" ALTER COLUMN "execution_reason" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "fill_audits" (
  "fill_id" uuid PRIMARY KEY REFERENCES "fills"("id") ON DELETE RESTRICT,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "entry_id" uuid NOT NULL REFERENCES "tournament_entries"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "symbol" "trading_symbol" NOT NULL,
  "position_side_before" varchar(8) NOT NULL,
  "position_side_after" varchar(8) NOT NULL,
  "order_intent" "order_intent" NOT NULL,
  "trigger_type" "execution_reason" NOT NULL,
  "requested_quantity" numeric(28,8) NOT NULL,
  "filled_quantity" numeric(28,8) NOT NULL,
  "leverage" integer NOT NULL,
  "average_entry_before" numeric(28,8),
  "mark_used" numeric(28,8) NOT NULL,
  "mark_provider" varchar(64) NOT NULL,
  "mark_source_timestamp" timestamptz NOT NULL,
  "mark_received_timestamp" timestamptz NOT NULL,
  "comparison_price" numeric(28,8),
  "fill_price" numeric(28,8) NOT NULL,
  "simulated_spread" numeric(28,8) NOT NULL,
  "simulated_slippage" numeric(28,8) NOT NULL,
  "fee" numeric(20,2) NOT NULL,
  "realized_pnl" numeric(20,2) NOT NULL,
  "unrealized_pnl_before" numeric(20,2) NOT NULL,
  "equity_before" numeric(20,2) NOT NULL,
  "equity_after" numeric(20,2) NOT NULL,
  "margin_before" numeric(20,2) NOT NULL,
  "margin_after" numeric(20,2) NOT NULL,
  "position_quantity_before" numeric(28,8) NOT NULL,
  "position_quantity_after" numeric(28,8) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fill_audits_position_sides_valid" CHECK (
    "position_side_before" IN ('NONE', 'LONG', 'SHORT') AND
    "position_side_after" IN ('NONE', 'LONG', 'SHORT')
  ),
  CONSTRAINT "fill_audits_prices_quantities_positive" CHECK (
    "requested_quantity" > 0 AND "filled_quantity" > 0 AND "mark_used" > 0 AND "fill_price" > 0
  ),
  CONSTRAINT "fill_audits_nonnegative_values" CHECK (
    "leverage" >= 1 AND "margin_before" >= 0 AND "margin_after" >= 0 AND
    "position_quantity_before" >= 0 AND "position_quantity_after" >= 0 AND
    "simulated_spread" >= 0 AND "simulated_slippage" >= 0 AND "fee" >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "fill_audits_order_idx" ON "fill_audits" ("order_id");
CREATE INDEX IF NOT EXISTS "fill_audits_entry_created_idx"
  ON "fill_audits" ("entry_id", "created_at" DESC);
