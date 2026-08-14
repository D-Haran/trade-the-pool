# API and realtime V1

All public product endpoints are under `/v1`. Responses wrap primary payloads in `data`; paged
responses also include `pagination`. Errors use `{ error: { code, message, requestId, details? } }`.
Unexpected failures are logged with their request ID and return only `INTERNAL_ERROR`.

## Authentication and authorization

Alpha authentication uses fixed-lifetime opaque sessions in Redis and a host-only secure cookie.
Login rotates the identifier, logout invalidates it and closes associated private realtime
connections, and temporary Redis/API failures remain connectivity failures rather than logout.
The complete lifetime, cookie, Redis restart/loss, CORS, CSRF, reverse-proxy, WebSocket, development
login, logging, and wallet identity contract is in
[`authentication.md`](authentication.md).

Public tournament and leaderboard reads do not require login. An authorization service owns all
private entry policies. Entry details, positions, history, orders, and private realtime topics
require the authenticated user to own the entry. No write route accepts a user ID.

Tournament reads expose exact decimal strings for `baseBankroll`, `currentPrizePool`,
`newEntryBankroll`, `currentEntryPrice`, and its allocation split. They include all schedule
timestamps, normalized fee bands, the next fee threshold, and an authoritative payout projection.
The server derives bankrolls, fee selection, and projected prizes; clients do not calculate them.

## Routes

- `GET /v1/auth/dev/users`, `POST /v1/auth/dev/login` (development only)
- `GET /v1/auth/me`, `POST /v1/auth/logout`
- `POST /v1/auth/wallet/challenge`, `POST /v1/auth/wallet/verify`
- `POST /v1/me/wallets/challenge`, `POST /v1/me/wallets/verify`
- `GET /v1/me/wallets`, `DELETE /v1/me/wallets/:id`
- `PUT /v1/me/wallets/:id/primary`
- `GET /v1/tournaments`, `GET /v1/tournaments/:id-or-slug`
- `GET /v1/markets`, `GET /v1/markets/:symbol`
- `GET /v1/markets/:symbol/candles?interval=1m|5m|15m|1h|4h|1d&limit=...`
- `GET /v1/markets/:symbol/book?depth=...`, `GET /v1/markets/:symbol/trades?limit=...`
- `POST /v1/tournaments/:id/entries`
- `GET /v1/me/entries`
- `GET /v1/entries/:id`, `/positions`, `/orders`, `/fills`, and `/performance`
- `POST /v1/orders` with an `Idempotency-Key` header
- `DELETE /v1/entries/:id/orders/:orderId`
- `PUT /v1/entries/:id/positions/:symbol/protection` with an `Idempotency-Key` header
- `GET /v1/tournaments/:id/leaderboard`
- `GET /v1/realtime` (WebSocket upgrade)
- `POST /v1/dev/market/advance` (development auth only)
- `GET /health/live`, `GET /health/ready`, `GET /health/market-data`

OpenAPI is generated from the same Zod request schemas registered with Fastify. In development,
set `API_DOCS_ENABLED=true` to serve `/openapi.json` and the explorer at `/documentation`; keep
them disabled where public docs are inappropriate.

Professional order bodies declare `intent: "OPEN" | "CLOSE"`,
`positionSide: "LONG" | "SHORT"`, and an `execution` object. Execution is `MARKET`, `LIMIT` with
`limitPrice`, or `STOP_MARKET` with `stopPrice`. Opens use exact string `notional` and may attach
take-profit/stop-loss prices; closes use either
`amount: { type: "QUANTITY", quantity: "..." }` or
`amount: { type: "PERCENTAGE", percentageBps: 5000 }`. The server derives BUY/SELL and never
accepts client prices for valuation or fills. The legacy long market request remains available
for backward compatibility.

## Account and leaderboard projections

The account snapshot service is the only API read model that derives cash, positions, realized
and unrealized P&L, equity, starting bankroll, and score. It calls the trading engine's exact
account logic and the authoritative market provider. Market ticks are never written across every
entry row. REST snapshots derive current marks on demand.

V1 score is exact cents: `current equity - starting bankroll`. Rows sort by descending exact score,
then entry creation time and entry ID. Maximum drawdown is not yet durable and is not fabricated.
Percentage return is also calculated with integer arithmetic.

Market snapshots and candles are produced behind one provider boundary. In live mode Kraken owns
the visible exchange context/candles/book/trades, Coinbase is an integrity comparison, and Pyth is
the execution mark; in fake mode the bounded deterministic provider aggregates exact OHLC and
reports unavailable volume. Provider response shapes never cross the API. The development advance
route accepts a validated symbol and decimal price but owns the event timestamp on the server. See
[`market-data.md`](market-data.md) for freshness, deviation, caching, failure, and settlement rules.

Redis stores one JSON ranking projection per tournament, already ordered using exact integer
arithmetic. This deliberately avoids Redis sorted-set `double` precision. PostgreSQL, positions,
and authoritative marks rebuild the full projection through `LeaderboardService.rebuild`. A
missing, malformed, flushed, or corrupt Redis value is therefore recoverable and cannot destroy
financial state. Entry creation and fills refresh one tournament. A market-symbol change queries
only tournaments with an open position in that symbol.

## Realtime contract

Clients first fetch REST state, connect, subscribe, and apply compact events. After any reconnect,
clients fetch REST again; V1 does not replay events. Allowed topics are:

- `market:<symbol>` — public `market.price`, `market.book`, `market.trades`, `market.candle`, and
  `market.status`
- `tournament:<id>` — public `tournament.prize_pool_updated`, `tournament.status_changed`, and
  `leaderboard.updated`
- `entry:<id>` — owner-only `entry.account_updated`

Clients send `{ "action": "subscribe" | "unsubscribe", "topic": "..." }`. Arbitrary Redis keys
and internal topics are rejected. The authoritative callback evaluates indexed pending orders for
that symbol and refreshes affected account/leaderboard projections. Execution and projection
failures are isolated so one does not prevent the other. Provider adapters remain replaceable
behind the provider/observer interfaces.

## Browser and abuse controls

Credentialed CORS uses the comma-separated `CORS_ALLOWED_ORIGINS`; wildcard credential origins are
rejected. Unsafe browser methods and WebSocket handshakes validate their origin against the same
list. JSON bodies are capped at 32 KiB. Zod schemas reject unknown fields, scientific
notation, excess precision, ambiguous sell shapes, and malformed subscriptions.

Centralized fixed-window limits are stored in Redis: auth 10/minute per IP; wallet challenges
10/minute per IP and address hash; wallet verification 10/minute per IP; wallet link, unlink, and
primary scopes 5/minute per user; repeated invalid signatures 5/five minutes per IP/address; entry creation
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
origin is `http://localhost:3000`; the API is `http://localhost:4000`. Use `localhost` consistently;
do not mix it with `127.0.0.1`. Both development servers bind to loopback by default. Set
`API_HOST` deliberately if another interface is required; never
expose development identity selection to an untrusted network.
