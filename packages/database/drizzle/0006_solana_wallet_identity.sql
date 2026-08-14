-- Durable Solana wallet identities. Wallets authenticate an application user; they never replace
-- users.id as the authorization principal. Challenge/replay state remains ephemeral in Redis.
DO $$ BEGIN
  CREATE TYPE "wallet_chain" AS ENUM ('SOLANA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "wallet_network" AS ENUM ('mainnet-beta', 'devnet', 'testnet', 'localnet');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "user_wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "address" varchar(44) NOT NULL,
  "chain" "wallet_chain" NOT NULL DEFAULT 'SOLANA',
  "network" "wallet_network" NOT NULL,
  "is_primary" boolean NOT NULL DEFAULT false,
  "verified_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_wallets_solana_address_format"
    CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
ALTER TABLE "user_wallets" DROP CONSTRAINT IF EXISTS "user_wallets_solana_address_length";
DO $$ BEGIN
  ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_solana_address_format"
    CHECK ("address" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A Solana public key is the same key on every cluster, so ownership is globally unique by its
-- canonical base58 address rather than by address + network.
CREATE UNIQUE INDEX IF NOT EXISTS "user_wallets_address_idx" ON "user_wallets" ("address");
CREATE UNIQUE INDEX IF NOT EXISTS "user_wallets_one_primary_per_user_idx"
  ON "user_wallets" ("user_id") WHERE "is_primary" = true;
CREATE INDEX IF NOT EXISTS "user_wallets_user_created_idx"
  ON "user_wallets" ("user_id", "created_at", "id");
