# Trade the Pool

Production-oriented competitive paper-trading platform foundation with a deterministic trading
engine, authenticated V1 API, exact leaderboard projections, realtime infrastructure, and Solana
wallet identity. Balance reads, custody, deposits, withdrawals, and real-money functionality remain
intentionally out of scope.

## Domain foundation

`packages/database` owns the PostgreSQL/Drizzle schema for users, tournaments, and tournament entries. Tournament lifecycle transitions and entry creation live in `packages/trading-engine`; route handlers must not contain database queries.

Tournament entry creation locks the tournament row with `SELECT ... FOR UPDATE`, snapshots `baseBankroll + currentPrizePool` as immutable `startingBankroll`, creates the entry, and then increments the prize pool in one transaction. Concurrent entrants therefore receive distinct ordered snapshots and either the complete operation commits or neither the entry nor prize-pool update remains.

Entry pricing now comes from normalized prize-pool fee tiers. Each entry also snapshots its fee,
allocation split, pre-entry prize pool, base bankroll, global serialized entry number, and optional
rakeback. Scheduled registration, trading start, entry close, and trading close boundaries are
server-authoritative. See [`docs/tournament-economics.md`](docs/tournament-economics.md).

All financial values are PostgreSQL `NUMERIC(20,2)` and are represented in domain code as exact integer cents (`bigint`). Values crossing boundaries are serialized as strings such as `"50000.00"`; JavaScript floating-point arithmetic is not used for accounting.

### Database commands

```bash
docker compose up -d postgres
pnpm --filter @trade-the-pool/database db:migrate
pnpm --filter @trade-the-pool/database db:seed
pnpm --filter @trade-the-pool/trading-engine test
pnpm simulate --runs 10000 --players 120 --seed 42
```

Run the PostgreSQL integration suite with `pnpm test:integration`. It applies the idempotent domain migration first and defaults to `postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool`; set `DATABASE_URL` to use another database. Fixtures use unique IDs and are cleaned up after each test.

The paper-trading engine's precision, fill, accounting, locking, idempotency, and reconciliation models are documented in [`docs/trading-engine.md`](docs/trading-engine.md).
The trading terminal supports authoritative 1x paper longs/shorts, market/limit/stop orders,
take-profit/stop-loss exits, exact performance history, multi-timeframe charts, and responsive
desktop/mobile workflows. It does not introduce real money, blockchain settlement, leverage, or
derivatives.
The deterministic economics simulator, population assumptions, arrival models, price regimes, and
fairness diagnostics are documented in [`docs/simulator.md`](docs/simulator.md).
The first 10,000-run baseline and its imbalance findings are in
[`docs/simulation-baseline.md`](docs/simulation-baseline.md).
The live/fake provider boundary, Kraken/Coinbase/Pyth responsibilities, freshness policy,
normalized fanout, and server-authoritative settlement flow are documented in
[`docs/market-data.md`](docs/market-data.md).

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

Development and CI use `MARKET_DATA_MODE=fake` by default. To use genuine public BTC/USD,
ETH/USD, and SOL/USD data locally, set `MARKET_DATA_MODE=live`, provide a server-side
`PYTH_API_KEY` plus all three current Pyth feed IDs, then start the same API/web processes. Live
configuration is validated at startup and never falls back to deterministic prices. See
[`docs/market-data.md`](docs/market-data.md) and [`.env.example`](.env.example).

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
Session lifetime, Redis/API restart behavior, cookies, CSRF, CORS, reverse-proxy topology, stable
PostgreSQL identity, and wallet/session behavior are documented in
[`docs/authentication.md`](docs/authentication.md).
The Solana wallet schema, SIWS proof protocol, linking policy, threat model, and next-phase boundary
are documented in [`docs/wallet-authentication.md`](docs/wallet-authentication.md).
The V1 routes, client state model, realtime lifecycle, chart, trading safeguards, and browser test
coverage are documented in [`docs/frontend.md`](docs/frontend.md).
