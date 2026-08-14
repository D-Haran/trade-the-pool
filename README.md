# Trade the Pool

Production-oriented competitive paper-trading platform foundation. Trading execution, authentication, Solana, wallets, and real-money functionality are intentionally out of scope for this phase.

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

The PostgreSQL concurrency test runs when `DATABASE_URL` is set; otherwise it is skipped so unit-only CI remains deterministic. Run it against the local database after migrations for integration validation.

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

The API validates required runtime configuration with Zod at startup. PostgreSQL is the durable database boundary and Redis is reserved for non-authoritative infrastructure concerns.
