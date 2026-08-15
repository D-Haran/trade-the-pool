# Frontend V1

The web application in `apps/web` is the V1 competitive paper-trading client. It is a
desktop-first, responsive financial terminal built with Next.js, React, TypeScript, Tailwind,
TanStack Query, Zustand, and TradingView Lightweight Charts.

## Routes

- `/` — product landing page backed by the live tournament API
- `/login` — Wallet Standard sign-in plus the development selector when enabled
- `/account` — browser wallet connection and application wallet-link management
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

Tournament discovery/detail surfaces distinguish Prize Pool, Base Bankroll, New Entry Bankroll,
Current Entry Price, podium projection, cash line, entry cap, entries, and real deadlines. The
terminal shows the entry's fixed Starting Bankroll separately from the current Prize Pool.

The API client sends cookies with every request and normalizes the API's success and error
envelopes. Authentication uses the server-issued HttpOnly session cookie. Wallets are discovered
through the shared Wallet Standard registry and use `solana:signIn` with a
`solana:signMessage` fallback over the exact server payload. The UI never holds keys, uses RPC, or
creates transactions. The development login selector discovers identities from the development
API and is explicitly separated from wallet authentication.

The account route distinguishes a browser wallet connection from a durable wallet link. It shows
canonical abbreviated addresses, verification cluster, primary status, link/unlink controls, and
a standalone frontend disconnect action. Unlinking does not log out; disconnecting does not unlink;
logout does neither. No balance, deposit, or withdrawal UI exists in this phase. See
[`wallet-authentication.md`](wallet-authentication.md).

Only an authoritative `401 AUTHENTICATION_REQUIRED` clears browser session state. A failed initial
session check renders a retryable unavailable state; cached authenticated views remain associated
with the same user during transient 5xx, Redis, offline, and reconnect failures. Login/logout reset
the WebSocket handshake, and logout removes private subscriptions. See
[`authentication.md`](authentication.md) for the complete contract.

## Realtime lifecycle

The browser maintains one WebSocket connection and reference-counted topic subscriptions.
Consumers subscribe to public market and tournament topics or to an owner-authorized entry topic.
The client applies compact market ticks directly where appropriate and invalidates affected query
snapshots for account, pool, status, and leaderboard events.

Disconnects use bounded exponential backoff with jitter. Browser offline/online transitions are
handled explicitly. After every reconnect, the app refetches REST state before treating the view
as synchronized because V1 intentionally has no event replay. An expired or explicitly invalidated
session clears private state and sends the user back through authentication. Transport reconnects
and `AUTHENTICATION_UNAVAILABLE` do not.

## Trading and multiple entries

Every terminal URL includes a concrete `entryId`; every order submission sends that same entry ID.
Changing entries navigates to a new terminal route and disables submission during the transition,
which prevents an order from crossing entry boundaries. Each entry has its own bankroll snapshot,
positions, P&L, history, and authorization boundary.

Order submissions use a stable idempotency key for the lifetime of one user intent. Network or
ambiguous failures retain that key so a retry cannot duplicate a fill. A successful fill or a
materially edited order creates the next intent. The ticket supports explicit LONG/SHORT paper
positions, asset-capped 1x–5x simulated leverage, market/limit/stop execution, notional presets,
margin and liquidation estimates, and optional take-profit/stop-loss prices. Position rows expose
leverage, notional, margin, liquidation price, 25%/50%/full server-validated closes, and editable
protection. All monetary and quantity fields remain decimal strings in the browser and are never
used for accounting calculations.

## Market chart

The chart initializes from normalized server OHLC, then merges incremental realtime candles by
symbol, timeframe, and UTC bucket. It supports candlestick/line display; 1m, 5m, 15m, 1h, 4h, and
1d intervals; SMA, EMA, VWAP, Bollinger Bands, RSI, MACD, and volume; reset; and fullscreen. VWAP
and volume are unavailable when the provider has no genuine volume. Query cancellation, scoped
subscriptions, and symbol checks prevent a slow prior-market request/event from overwriting a new
selection. Backend freshness/deviation state pauses submission; the browser does not invent a
local execution authority.

Desktop places a compact Kraken-labelled market-depth/recent-trades panel between the chart and
order ticket. Depth rows show exact price, size, cumulative size, spread, and restrained shading.
Book updates are batched with `requestAnimationFrame`; trades use a bounded list. Both bootstrap
from REST and use the selected market's existing WebSocket topic thereafter.

The terminal keeps a persistent `PAPER` identity and selected market preferences in Zustand. A
single bulk market query powers the scrollable 12-asset watchlist and objective Market Pulse
signals; only the active market receives the high-frequency chart subscription. Its desktop layout
keeps the watchlist, chart, order ticket, tournament/account strip, and data tabs in view together.
Mobile preserves the same hierarchy as stacked sections and card-like table rows.
Open orders, order history, trades, performance, positions, and leaderboard panels use API state;
missing performance statistics such as durable max drawdown render as unavailable.

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

Unit tests cover display formatting, market candle aggregation/statistics, directional accounting,
and order triggers. Integration tests cover long and short fills, partial/full closes, limits,
protection OCO behavior, idempotency, cancellation, and tournament-close expiry. Playwright tests
use fixed PostgreSQL and Redis fixtures, exercise the primary terminal workflows, market/timeframe
switching, indicators, realtime recovery, responsive overflow, and deterministic visual baselines.
Fixture cleanup is limited to the exact records created by the test suite.
