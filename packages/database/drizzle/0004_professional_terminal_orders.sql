-- Explicit long/short positions and server-authoritative conditional orders.
DO $$ BEGIN CREATE TYPE "position_side" AS ENUM ('LONG', 'SHORT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "order_intent" AS ENUM ('OPEN', 'CLOSE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'LIMIT';
ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'STOP_MARKET';
ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'TAKE_PROFIT';
ALTER TYPE "order_type" ADD VALUE IF NOT EXISTS 'STOP_LOSS';
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'OPEN';
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'TRIGGERED';
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'EXPIRED';
