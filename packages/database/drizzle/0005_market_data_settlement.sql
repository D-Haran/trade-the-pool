CREATE TABLE IF NOT EXISTS "tournament_settlement_marks" (
  "tournament_id" uuid NOT NULL REFERENCES "tournaments"("id"),
  "symbol" "trading_symbol" NOT NULL,
  "price" numeric(28, 8) NOT NULL,
  "confidence" numeric(28, 8),
  "source" varchar(64) NOT NULL,
  "market_timestamp" timestamptz NOT NULL,
  "locked_at" timestamptz NOT NULL,
  CONSTRAINT "tournament_settlement_marks_pkey" PRIMARY KEY ("tournament_id", "symbol"),
  CONSTRAINT "tournament_settlement_marks_price_positive" CHECK ("price" > 0),
  CONSTRAINT "tournament_settlement_marks_confidence_nonnegative" CHECK (
    "confidence" IS NULL OR "confidence" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "tournament_settlement_marks_locked_at_idx"
  ON "tournament_settlement_marks" ("locked_at");
