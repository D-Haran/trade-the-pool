# API and realtime V1

All public product endpoints are under `/v1`. Responses wrap primary payloads in `data`; paged
responses also include `pagination`. Errors use `{ error: { code, message, requestId, details? } }`.
Unexpected failures are logged with their request ID and return only `INTERNAL_ERROR`.

## Authentication and authorization

Alpha authentication uses opaque 256-bit server-issued session IDs stored in Redis with an
expiry. The browser receives only an `HttpOnly`, `SameSite=Lax` cookie; it is `Secure` in
production. Logout deletes the Redis session. Sessions contain identity and expiry only, never
account state. `DEV_AUTH_ENABLED=true` registers user-selection login routes only outside
production; environment validation rejects that combination in production. This authentication
service is deliberately independent from route and trading logic so wallet-signature auth can be
added later.

Public tournament and leaderboard reads do not require login. An authorization service owns all
private entry policies. Entry details, positions, history, orders, and private realtime topics
require the authenticated user to own the entry. No write route accepts a user ID.

Tournament reads expose exact decimal strings for `baseBankroll`, `currentPrizePool`,
`newEntryBankroll`, and `entryContribution`. The server derives `newEntryBankroll` as base plus
the current prize pool; clients do not calculate authoritative financial projections.

## Routes

- `GET /v1/auth/dev/users`, `POST /v1/auth/dev/login` (development only)
- `GET /v1/auth/me`, `POST /v1/auth/logout`
- `GET /v1/tournaments`, `GET /v1/tournaments/:id-or-slug`
- `GET /v1/markets/:symbol`
- `GET /v1/markets/:symbol/candles?interval=1m|5m|15m|1h&limit=...`
- `POST /v1/tournaments/:id/entries`
- `GET /v1/me/entries`
- `GET /v1/entries/:id`, `/positions`, and `/orders`
- `POST /v1/orders` with an `Idempotency-Key` header
- `GET /v1/tournaments/:id/leaderboard`
- `GET /v1/realtime` (WebSocket upgrade)
- `POST /v1/dev/market/advance` (development auth only)
- `GET /health/live`, `GET /health/ready`

OpenAPI is generated from the same Zod request schemas registered with Fastify. In development,
set `API_DOCS_ENABLED=true` to serve `/openapi.json` and the explorer at `/documentation`; keep
them disabled where public docs are inappropriate.

Sell bodies use an explicit nested discriminant: `amount: { type: "QUANTITY", quantity: "..." }`
or `amount: { type: "PERCENTAGE", percentageBps: 5000 }`. The two forms cannot be combined.

## Account and leaderboard projections

The account snapshot service is the only API read model that derives cash, positions, realized
and unrealized P&L, equity, starting bankroll, and score. It calls the trading engine's exact
account logic and the authoritative market provider. Market ticks are never written across every
entry row. REST snapshots derive current marks on demand.

V1 score is exact cents: `current equity - starting bankroll`. Rows sort by descending exact score,
then entry creation time and entry ID. Maximum drawdown is not yet durable and is not fabricated.
Percentage return is also calculated with integer arithmetic.

Market snapshots and candles are produced by the authoritative market provider. The deterministic
development provider maintains a bounded tick history and aggregates exact OHLC values into 1m,
5m, 15m, and 1h candles. `MarketHistoryProvider` and `ControllableMarketPriceProvider` keep this
behavior behind explicit interfaces so the development controls can be removed when a live source
is connected. The development advance route accepts a validated symbol and decimal price but owns
the event timestamp on the server.

Redis stores one JSON ranking projection per tournament, already ordered using exact integer
arithmetic. This deliberately avoids Redis sorted-set `double` precision. PostgreSQL, positions,
and authoritative marks rebuild the full projection through `LeaderboardService.rebuild`. A
missing, malformed, flushed, or corrupt Redis value is therefore recoverable and cannot destroy
financial state. Entry creation and fills refresh one tournament. A market-symbol change queries
only tournaments with an open position in that symbol.

## Realtime contract

Clients first fetch REST state, connect, subscribe, and apply compact events. After any reconnect,
clients fetch REST again; V1 does not replay events. Allowed topics are:

- `market:<symbol>` — public `market.price`
- `tournament:<id>` — public `tournament.prize_pool_updated`, `tournament.status_changed`, and
  `leaderboard.updated`
- `entry:<id>` — owner-only `entry.account_updated`

Clients send `{ "action": "subscribe" | "unsubscribe", "topic": "..." }`. Arbitrary Redis keys
and internal topics are rejected. The deterministic provider emits market events today and can be
replaced behind the existing provider/observer interfaces.

## Browser and abuse controls

Credentialed CORS uses the comma-separated `CORS_ALLOWED_ORIGINS`; wildcard credential origins are
not supported. JSON bodies are capped at 32 KiB. Zod schemas reject unknown fields, scientific
notation, excess precision, ambiguous sell shapes, and malformed subscriptions.

Centralized fixed-window limits are stored in Redis: auth 10/minute per IP, entry creation
10/minute per user, orders 120/minute per user, WebSocket connects 20/minute per IP, and
subscriptions 60/minute per user or IP. Audit logs record login/logout, entry creation, order
submission/fill, request/user/resource IDs, and timestamps without request bodies or tokens.

## Local development

```bash
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The seeded development identities have stable IDs, making repeated seeds idempotent. The frontend
origin is `http://localhost:3000`; the API is `http://localhost:4000`. Both development servers
bind to loopback by default. Set `API_HOST` deliberately if another interface is required; never
expose development identity selection to an untrusted network.
