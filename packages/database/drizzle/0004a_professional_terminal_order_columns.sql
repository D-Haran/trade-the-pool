ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "side" "position_side";
UPDATE "positions" SET "side" = 'LONG' WHERE "side" IS NULL;
ALTER TABLE "positions" ALTER COLUMN "side" SET DEFAULT 'LONG';
ALTER TABLE "positions" ALTER COLUMN "side" SET NOT NULL;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "position_side" "position_side";
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intent" "order_intent";
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "limit_price" numeric(28,8);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "trigger_price" numeric(28,8);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "parent_order_id" uuid;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "oco_group_id" uuid;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "rejection_reason" varchar(160);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancellation_reason" varchar(160);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "triggered_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "filled_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz;

UPDATE "orders"
SET "position_side" = 'LONG',
    "intent" = CASE WHEN "side" = 'BUY' THEN 'OPEN'::"order_intent" ELSE 'CLOSE'::"order_intent" END,
    "filled_at" = CASE WHEN "status" = 'FILLED' THEN "updated_at" ELSE "filled_at" END
WHERE "position_side" IS NULL OR "intent" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "position_side" SET DEFAULT 'LONG';
ALTER TABLE "orders" ALTER COLUMN "position_side" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "intent" SET DEFAULT 'OPEN';
ALTER TABLE "orders" ALTER COLUMN "intent" SET NOT NULL;

ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "position_side" "position_side";
ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "intent" "order_intent";
ALTER TABLE "fills" ADD COLUMN IF NOT EXISTS "realized_pnl" numeric(20,2) NOT NULL DEFAULT 0.00;
UPDATE "fills" fill
SET "position_side" = COALESCE(fill."position_side", orders."position_side"),
    "intent" = COALESCE(fill."intent", orders."intent")
FROM "orders" orders
WHERE orders."id" = fill."order_id";
ALTER TABLE "fills" ALTER COLUMN "position_side" SET DEFAULT 'LONG';
ALTER TABLE "fills" ALTER COLUMN "position_side" SET NOT NULL;
ALTER TABLE "fills" ALTER COLUMN "intent" SET DEFAULT 'OPEN';
ALTER TABLE "fills" ALTER COLUMN "intent" SET NOT NULL;

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_request_shape_valid";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_price_shape_valid";
ALTER TABLE "orders" ADD CONSTRAINT "orders_request_shape_valid" CHECK (
  (intent = 'OPEN' AND requested_notional IS NOT NULL AND requested_quantity IS NULL AND requested_percentage_bps IS NULL)
  OR
  (intent = 'CLOSE' AND requested_notional IS NULL AND ((requested_quantity IS NOT NULL)::int + (requested_percentage_bps IS NOT NULL)::int) = 1)
);
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_shape_valid" CHECK (
  (order_type::text IN ('MARKET', 'LIQUIDATION') AND limit_price IS NULL AND trigger_price IS NULL)
  OR
  (order_type = 'LIMIT' AND limit_price IS NOT NULL AND trigger_price IS NULL)
  OR
  (order_type IN ('STOP_MARKET', 'TAKE_PROFIT', 'STOP_LOSS') AND limit_price IS NULL AND trigger_price IS NOT NULL)
);
DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "orders_limit_price_positive" CHECK (limit_price IS NULL OR limit_price > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "orders_trigger_price_positive" CHECK (trigger_price IS NULL OR trigger_price > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "orders_open_symbol_trigger_idx"
ON "orders" ("symbol", "status", "created_at", "id")
WHERE "status" = 'OPEN';
CREATE INDEX IF NOT EXISTS "orders_entry_open_idx"
ON "orders" ("entry_id", "status", "created_at")
WHERE "status" = 'OPEN';
