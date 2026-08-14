# Frontend V1

The web application in `apps/web` is the V1 competitive paper-trading client. It is a
desktop-first, responsive financial terminal built with Next.js, React, TypeScript, Tailwind,
TanStack Query, Zustand, and TradingView Lightweight Charts.

## Routes

- `/` — product landing page backed by the live tournament API
- `/login` — development identity selector when development auth is enabled
- `/tournaments` — live, upcoming, and completed tournament discovery
- `/tournaments/:slug` — tournament rules, prize pool, bankroll terms, entries, and leaderboard
- `/dashboard` — the authenticated user's entries and results
- `/tournaments/:slug/trade/:entryId` — the trading terminal for one owned entry
- `/dev/market` — development-only deterministic market controls

The visual language is intentionally restrained: dark surfaces, strong number typography,
compact market data, and generous spacing around product explanations. Desktop layouts use the
available width for simultaneous chart, order ticket, account, and ranking context. Tablet and
mobile layouts stack the same information without horizontal page overflow and provide a bottom
navigation bar for primary destinations.

## Server-authoritative state

TanStack Query owns remote state. The client does not calculate balances, fills, P&L, equity,
rank, tournament status, prize-pool values, or new-entry bankrolls. Those values come from REST snapshots and realtime
invalidation events. Client clocks are used only to improve deadline presentation and disable an
obviously expired control; the API remains authoritative for every write.

The API client sends cookies with every request and normalizes the API's success and error
envelopes. Authentication uses the server-issued HttpOnly session cookie. The development login
selector discovers its identities from the development API and is not presented as production
authentication.

## Realtime lifecycle

The browser maintains one WebSocket connection and reference-counted topic subscriptions.
Consumers subscribe to public market and tournament topics or to an owner-authorized entry topic.
The client applies compact market ticks directly where appropriate and invalidates affected query
snapshots for account, pool, status, and leaderboard events.

Disconnects use bounded exponential backoff with jitter. Browser offline/online transitions are
handled explicitly. After every reconnect, the app refetches REST state before treating the view
as synchronized because V1 intentionally has no event replay. An expired session clears private
state and sends the user back through authentication.

## Trading and multiple entries

Every terminal URL includes a concrete `entryId`; every order submission sends that same entry ID.
Changing entries navigates to a new terminal route and disables submission during the transition,
which prevents an order from crossing entry boundaries. Each entry has its own bankroll snapshot,
positions, P&L, history, and authorization boundary.

Order submissions use a stable idempotency key for the lifetime of one user intent. Network or
ambiguous failures retain that key so a retry cannot duplicate a fill. A successful fill or a
materially edited order creates the next intent. Buy tickets accept an exact notional; sell tickets
accept an exact quantity or a server-validated percentage. All monetary and quantity fields remain
decimal strings in the browser and are never used for accounting calculations.

## Market chart

The chart initializes from server-generated OHLC candles and applies authoritative market ticks
imperatively. It supports 1 minute, 5 minute, 15 minute, and 1 hour intervals. The deterministic
development provider exposes the same snapshot/history/observer interfaces expected of a later
live provider. Prices older than 30 seconds are presented as stale and order submission is paused
until an authoritative update arrives.

## Accessibility and failure states

Interactive controls use native buttons, links, labels, tables, focus indicators, and keyboard
navigation. Dense data tables have responsive containers and descriptive empty states. Loading,
route-error, authorization, stale-market, offline, reconnecting, and rejected-order states are
visible rather than silently degraded. Motion is reduced for users who request it.

## Development and testing

With PostgreSQL and Redis running, migrate and seed the database, then start the API and web app:

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`DEV_AUTH_ENABLED=true` enables the local identity selector and `POST /v1/dev/market/advance` only
outside production. The market-control route advances server-owned time and price; it does not let
the client provide balances, fills, or accounting state.

Unit tests cover display formatting and market candle aggregation. Playwright tests use fixed
PostgreSQL and Redis fixtures, exercise authentication persistence, entry creation, pool snapshots,
buy and sell flows, mark-to-market, multiple-entry isolation, ownership checks, close boundaries,
WebSocket recovery, responsive overflow, and deterministic visual baselines. Fixture cleanup is
limited to the exact records created by the test suite.
