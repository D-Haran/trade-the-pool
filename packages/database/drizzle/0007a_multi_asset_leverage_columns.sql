-- Kept separate so PostgreSQL commits the enum additions before they are referenced.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "leverage" integer NOT NULL DEFAULT 1;
ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "leverage" integer NOT NULL DEFAULT 1;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "leverage" integer NOT NULL DEFAULT 1;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "margin_used" numeric(20,2) NOT NULL DEFAULT 0.00;
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "liquidation_price" numeric(28,8);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "is_busted" boolean NOT NULL DEFAULT false;
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "busted_at" timestamptz;
-- Leveraged long exposure uses an explicit simulated financing balance; equity remains bounded by
-- marked assets, margin, and liquidation rules rather than by a nonnegative cash constraint.
ALTER TABLE "tournament_entries" DROP CONSTRAINT IF EXISTS "tournament_entries_cash_check";

UPDATE "positions"
SET "margin_used" = ROUND("quantity" * "average_entry_price", 2)
WHERE "quantity" > 0 AND "margin_used" = 0;

DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "orders_leverage_valid" CHECK ("leverage" BETWEEN 1 AND 5); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "fills" ADD CONSTRAINT "fills_leverage_valid" CHECK ("leverage" BETWEEN 1 AND 5); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "positions" ADD CONSTRAINT "positions_leverage_valid" CHECK ("leverage" BETWEEN 1 AND 5); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "positions" ADD CONSTRAINT "positions_margin_nonnegative" CHECK ("margin_used" >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "positions" ADD CONSTRAINT "positions_liquidation_price_positive" CHECK ("liquidation_price" IS NULL OR "liquidation_price" > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_bust_timestamp_valid" CHECK (("is_busted" = false AND "busted_at" IS NULL) OR ("is_busted" = true AND "busted_at" IS NOT NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_price_shape_valid";
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_shape_valid" CHECK (
  ("order_type" IN ('MARKET', 'LIQUIDATION') AND "limit_price" IS NULL AND "trigger_price" IS NULL)
  OR ("order_type" = 'LIMIT' AND "limit_price" IS NOT NULL AND "trigger_price" IS NULL)
  OR ("order_type" IN ('STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS') AND "limit_price" IS NULL AND "trigger_price" IS NOT NULL)
);
