-- Split the legacy simulated_pool concept without changing any existing entry snapshot.
-- For tournaments with entries, the earliest locked bankroll is treated as the fixed base and
-- subsequent legacy growth becomes the current prize pool. Tournaments without entries retain
-- their configured amount as base bankroll and begin with a zero prize pool.
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "base_bankroll" numeric(20,2);
ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "current_prize_pool" numeric(20,2);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tournaments' AND column_name = 'simulated_pool'
  ) THEN
    ALTER TABLE "tournaments" ADD COLUMN IF NOT EXISTS "entry_contribution" numeric(20,2);
    EXECUTE $migration$
      WITH entry_baselines AS (
        SELECT tournament_id, min(starting_bankroll) AS first_bankroll
        FROM tournament_entries
        GROUP BY tournament_id
      )
      UPDATE tournaments AS t
      SET base_bankroll = LEAST(COALESCE(b.first_bankroll, t.simulated_pool), t.simulated_pool),
          current_prize_pool = t.simulated_pool - LEAST(COALESCE(b.first_bankroll, t.simulated_pool), t.simulated_pool),
          entry_contribution = t.simulated_entry_contribution
      FROM (SELECT t2.id, e.first_bankroll FROM tournaments t2 LEFT JOIN entry_baselines e ON e.tournament_id = t2.id) AS b
      WHERE b.id = t.id AND t.base_bankroll IS NULL
    $migration$;
  END IF;
END $$;

ALTER TABLE "tournaments" ALTER COLUMN "base_bankroll" SET NOT NULL;
ALTER TABLE "tournaments" ALTER COLUMN "current_prize_pool" SET NOT NULL;
DO $$ BEGIN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_base_bankroll_nonnegative" CHECK (base_bankroll >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_current_prize_pool_nonnegative" CHECK (current_prize_pool >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tournaments" DROP COLUMN IF EXISTS "simulated_pool";
ALTER TABLE "tournaments" DROP COLUMN IF EXISTS "simulated_entry_contribution";
