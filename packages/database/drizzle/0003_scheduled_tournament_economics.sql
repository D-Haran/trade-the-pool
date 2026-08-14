-- Scheduled tournament lifecycle, normalized fee bands, auditable entry economics, and
-- simulated payout/rakeback configuration. This migration is intentionally idempotent because
-- the local migration runner reapplies every migration file.
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "registration_opens_at" timestamptz;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "trading_starts_at" timestamptz;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "payout_config" jsonb;
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "rakeback_config" jsonb;

UPDATE "tournaments"
SET "registration_opens_at" = COALESCE("registration_opens_at", "opens_at", "created_at"),
    "trading_starts_at" = COALESCE("trading_starts_at", "opens_at", "created_at"),
    "entry_closes_at" = GREATEST(
      COALESCE("entry_closes_at", "opens_at" + interval '1 day', "created_at" + interval '1 day'),
      COALESCE("trading_starts_at", "opens_at", "created_at") + interval '1 second'
    ),
    "trading_closes_at" = GREATEST(
      COALESCE("trading_closes_at", "opens_at" + interval '2 days', "created_at" + interval '2 days'),
      COALESCE("entry_closes_at", "opens_at" + interval '1 day', "created_at" + interval '1 day')
    ),
    "payout_config" = COALESCE(
      "payout_config",
      '{"directPrizes":[{"position":1,"basisPoints":4000},{"position":2,"basisPoints":2000},{"position":3,"basisPoints":1000}],"additionalCashLine":{"percentileBasisPoints":1000,"allocationBasisPoints":3000}}'::jsonb
    );

UPDATE "tournaments" SET "status" = 'TRADING_ACTIVE' WHERE "status" = 'OPEN';

ALTER TABLE "tournaments" ALTER COLUMN "registration_opens_at" SET NOT NULL;
ALTER TABLE "tournaments" ALTER COLUMN "trading_starts_at" SET NOT NULL;
ALTER TABLE "tournaments" ALTER COLUMN "entry_closes_at" SET NOT NULL;
ALTER TABLE "tournaments" ALTER COLUMN "trading_closes_at" SET NOT NULL;
ALTER TABLE "tournaments" ALTER COLUMN "payout_config" SET NOT NULL;
DO $$ BEGIN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_max_entries_positive" CHECK (max_entries_per_user > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_schedule_ordered" CHECK (registration_opens_at <= trading_starts_at AND trading_starts_at < entry_closes_at AND entry_closes_at <= trading_closes_at); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tournament_entry_fee_tiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tournament_id" uuid NOT NULL REFERENCES "tournaments"("id"),
  "ordinal" integer NOT NULL CHECK (ordinal >= 0),
  "min_prize_pool" numeric(20,2) NOT NULL CHECK (min_prize_pool >= 0),
  "max_prize_pool" numeric(20,2),
  "entry_fee" numeric(20,2) NOT NULL,
  "prize_pool_contribution" numeric(20,2) NOT NULL,
  "platform_fee" numeric(20,2) NOT NULL,
  "future_reward_allocation" numeric(20,2) NOT NULL DEFAULT 0.00,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tournament_fee_tiers_range_valid" CHECK (max_prize_pool IS NULL OR max_prize_pool > min_prize_pool),
  CONSTRAINT "tournament_fee_tiers_allocations_valid" CHECK (
    entry_fee >= 0 AND prize_pool_contribution >= 0 AND platform_fee >= 0 AND
    future_reward_allocation >= 0 AND
    entry_fee = prize_pool_contribution + platform_fee + future_reward_allocation
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "tournament_fee_tiers_ordinal_idx" ON "tournament_entry_fee_tiers" ("tournament_id", "ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "tournament_fee_tiers_min_pool_idx" ON "tournament_entry_fee_tiers" ("tournament_id", "min_prize_pool");

INSERT INTO "tournament_entry_fee_tiers"
  ("tournament_id", "ordinal", "min_prize_pool", "max_prize_pool", "entry_fee", "prize_pool_contribution", "platform_fee", "future_reward_allocation")
SELECT "id", 0, 0.00, NULL, "entry_contribution", "entry_contribution", 0.00, 0.00
FROM "tournaments"
WHERE NOT EXISTS (
  SELECT 1 FROM "tournament_entry_fee_tiers" tier WHERE tier."tournament_id" = "tournaments"."id"
);

ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "tournament_entry_number" integer;
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "entry_fee" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "prize_pool_before_entry" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "prize_pool_contribution" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "platform_allocation" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "future_reward_allocation" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "rakeback_amount" numeric(20,2);
ALTER TABLE "tournament_entries" ADD COLUMN IF NOT EXISTS "base_bankroll_snapshot" numeric(20,2);

WITH numbered AS (
  SELECT "id", row_number() OVER (PARTITION BY "tournament_id" ORDER BY "created_at", "id") AS tournament_number
  FROM "tournament_entries"
)
UPDATE "tournament_entries" entry
SET "tournament_entry_number" = COALESCE(entry."tournament_entry_number", numbered.tournament_number),
    "entry_fee" = COALESCE(entry."entry_fee", tournament."entry_contribution"),
    "prize_pool_before_entry" = COALESCE(entry."prize_pool_before_entry", entry."starting_bankroll" - tournament."base_bankroll"),
    "prize_pool_contribution" = COALESCE(entry."prize_pool_contribution", tournament."entry_contribution"),
    "platform_allocation" = COALESCE(entry."platform_allocation", 0.00),
    "future_reward_allocation" = COALESCE(entry."future_reward_allocation", 0.00),
    "rakeback_amount" = COALESCE(entry."rakeback_amount", 0.00),
    "base_bankroll_snapshot" = COALESCE(entry."base_bankroll_snapshot", tournament."base_bankroll")
FROM numbered, "tournaments" tournament
WHERE numbered."id" = entry."id" AND tournament."id" = entry."tournament_id";

ALTER TABLE "tournament_entries" ALTER COLUMN "tournament_entry_number" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "entry_fee" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "prize_pool_before_entry" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "prize_pool_contribution" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "platform_allocation" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "future_reward_allocation" SET DEFAULT 0.00;
ALTER TABLE "tournament_entries" ALTER COLUMN "future_reward_allocation" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "rakeback_amount" SET DEFAULT 0.00;
ALTER TABLE "tournament_entries" ALTER COLUMN "rakeback_amount" SET NOT NULL;
ALTER TABLE "tournament_entries" ALTER COLUMN "base_bankroll_snapshot" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "tournament_entries_tournament_number_idx" ON "tournament_entries" ("tournament_id", "tournament_entry_number");
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_sequence_positive" CHECK (sequence_number > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_economics_nonnegative" CHECK (tournament_entry_number > 0 AND entry_fee >= 0 AND prize_pool_before_entry >= 0 AND prize_pool_contribution >= 0 AND platform_allocation >= 0 AND future_reward_allocation >= 0 AND rakeback_amount >= 0 AND base_bankroll_snapshot >= 0 AND starting_bankroll > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_bankroll_snapshot_valid" CHECK (starting_bankroll = base_bankroll_snapshot + prize_pool_before_entry); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_fee_snapshot_valid" CHECK (entry_fee = prize_pool_contribution + platform_allocation + future_reward_allocation); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_rakeback_bounded" CHECK (rakeback_amount <= platform_allocation); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION prevent_tournament_entry_economics_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW.tournament_id, NEW.user_id, NEW.sequence_number, NEW.tournament_entry_number,
    NEW.entry_fee, NEW.prize_pool_before_entry, NEW.prize_pool_contribution,
    NEW.platform_allocation, NEW.future_reward_allocation, NEW.rakeback_amount,
    NEW.base_bankroll_snapshot, NEW.starting_bankroll, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.tournament_id, OLD.user_id, OLD.sequence_number, OLD.tournament_entry_number,
    OLD.entry_fee, OLD.prize_pool_before_entry, OLD.prize_pool_contribution,
    OLD.platform_allocation, OLD.future_reward_allocation, OLD.rakeback_amount,
    OLD.base_bankroll_snapshot, OLD.starting_bankroll, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'tournament entry economics are immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "tournament_entry_economics_immutable" ON "tournament_entries";
CREATE TRIGGER "tournament_entry_economics_immutable"
BEFORE UPDATE ON "tournament_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_tournament_entry_economics_update();

-- Legacy columns remain nullable only so the intentionally idempotent historical migrations can
-- inspect old installations. Current schema, seed data, and application code do not use them.
ALTER TABLE "tournaments" ALTER COLUMN "entry_contribution" DROP NOT NULL;
