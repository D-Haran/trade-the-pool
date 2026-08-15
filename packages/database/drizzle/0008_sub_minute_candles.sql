DO $$ BEGIN
 CREATE TYPE "public"."sub_minute_candle_interval" AS ENUM('5s', '15s', '30s');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sub_minute_candles" (
  "symbol" "trading_symbol" NOT NULL,
  "interval" "sub_minute_candle_interval" NOT NULL,
  "timestamp" timestamp with time zone NOT NULL,
  "open" numeric(28, 8) NOT NULL,
  "high" numeric(28, 8) NOT NULL,
  "low" numeric(28, 8) NOT NULL,
  "close" numeric(28, 8) NOT NULL,
  "volume" numeric(28, 8) NOT NULL,
  "source" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sub_minute_candles_symbol_interval_timestamp_pk" PRIMARY KEY("symbol", "interval", "timestamp"),
  CONSTRAINT "sub_minute_candles_price_valid" CHECK ("open" > 0 AND "high" >= "low" AND "close" > 0),
  CONSTRAINT "sub_minute_candles_volume_nonnegative" CHECK ("volume" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_minute_candles_history_idx" ON "sub_minute_candles" USING btree ("symbol", "interval", "timestamp" DESC);
