# Trade the Pool

Production-oriented competitive paper-trading platform foundation with a deterministic trading
engine, authenticated V1 API, exact leaderboard projections, and realtime infrastructure. Solana,
wallets, and real-money functionality remain intentionally out of scope.

## Domain foundation

`packages/database` owns the PostgreSQL/Drizzle schema for users, tournaments, and tournament entries. Tournament lifecycle transitions and entry creation live in `packages/trading-engine`; route handlers must not contain database queries.

Tournament entry creation locks the tournament row with `SELECT ... FOR UPDATE`, snapshots the current `simulatedPool` as immutable `startingBankroll`, creates the entry, and increments the pool in one transaction. Concurrent entrants therefore receive distinct ordered snapshots and either the complete operation commits or neither the entry nor pool update remains.

All financial values are PostgreSQL `NUMERIC(20,2)` and are represented in domain code as exact integer cents (`bigint`). Values crossing boundaries are serialized as strings such as `"50000.00"`; JavaScript floating-point arithmetic is not used for accounting.

### Database commands

```bash
docker compose up -d postgres
pnpm --filter @trade-the-pool/database db:migrate
pnpm --filter @trade-the-pool/database db:seed
pnpm --filter @trade-the-pool/trading-engine test
```

Run the PostgreSQL integration suite with `pnpm test:integration`. It applies the idempotent domain migration first and defaults to `postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool`; set `DATABASE_URL` to use another database. Fixtures use unique IDs and are cleaned up after each test.

The paper-trading engine's precision, fill, accounting, locking, idempotency, and reconciliation models are documented in [`docs/trading-engine.md`](docs/trading-engine.md).

## Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for local PostgreSQL and Redis)

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
```

## Development

```bash
pnpm dev             # web and API in parallel
pnpm --filter @trade-the-pool/web dev
pnpm --filter @trade-the-pool/api dev
```

The web app runs on `http://localhost:3000`; the API health endpoint is `http://localhost:4000/health`.

## Validation

```bash
pnpm check          # format, lint, typecheck, tests, and builds
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The API validates required runtime configuration with Zod at startup. PostgreSQL is the durable
database boundary; Redis stores expiring sessions, rate-limit counters, and recoverable realtime
leaderboard projections only. See [`docs/api-realtime.md`](docs/api-realtime.md) for routes,
security, recovery, and the frontend snapshot/subscription contract.
