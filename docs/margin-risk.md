# Multi-asset margin and liquidation

## Canonical universe

`packages/shared/src/markets.ts` is the product-wide source of truth. The enabled USD markets are
BTC, ETH, SOL, XRP, DOGE, LINK, AVAX, ADA, SUI, AAVE, NEAR, and LTC. Each record owns its display
name, base/quote assets, precision, schedule, icon key, provider mappings, order, and maximum
leverage. API validation, provider subscriptions, websocket authorization, settlement, and the web
selector consume this registry; arbitrary user-provided tickers are rejected.

The deterministic provider supplies every market for local development and tests. Live mode
requires Kraken and Coinbase mappings plus a Pyth feed ID for every enabled market and fails at
startup if any authoritative feed is missing. There is no implicit live-to-fake fallback.

## Initial margin and exposure

Leverage is an integer selected per opening order and capped by market: BTC/ETH up to 5x, SOL up to
4x, XRP/DOGE/LINK/AVAX/LTC up to 3x, and ADA/SUI/AAVE/NEAR up to 2x. The server validates the cap;
the client selector is only presentation.

```text
initial margin = ceil-to-cent(fill notional / leverage)
free margin    = marked equity - open-position margin - pending-open margin
gross limit    = marked equity * 5
```

Fees are also required at submission and fill time. Pending limit and stop opens reserve their
initial margin and notional, so concurrent or sequential open orders cannot collectively exceed
free margin or the gross exposure ceiling. Entry rows are locked and all order, fill, position,
ledger, and cached-account writes commit atomically. Idempotency keys prevent duplicate execution.

Additions to an existing symbol must use its current leverage until that position is fully closed.
Partial closes release margin in exact proportion to quantity; the final close releases the full
remainder. Orders, fills, and positions persist leverage. Positions additionally persist margin
used and the current liquidation estimate.

## Cash, equity, and P&L

Leverage never multiplies price P&L. Long buys debit the full simulated purchase amount and shorts
credit the full simulated sale amount, preserving the existing auditable cash ledger. Leveraged
longs can therefore have a negative financing cash balance. Authoritative equity remains:

```text
cash + long marked value - short marked liability
```

All values use fixed-precision integer or PostgreSQL numeric arithmetic. Binary floating point is
limited to non-authoritative display formatting.

## Liquidation and bust state

The model uses a 20% maintenance requirement against each position's initial margin. Its isolated
estimate allows losses to consume the remaining 80%:

```text
loss capacity = initial margin - 20% of initial margin
long liquidation  = entry price - loss capacity / quantity
short liquidation = entry price + loss capacity / quantity
```

Every authoritative market tick runs liquidation before conditional orders. Crossing the stored
threshold creates an idempotent server-owned `LIQUIDATION` close order and fill through the same
transactional execution path. The event is visible in order and trade history. An entry whose
marked equity reaches zero or below is marked busted, all remaining open orders expire, and new
opens are rejected; reads and tournament ranking remain available.

This is a deliberately simplified competition model, not an exchange margin engine. It has no
cross-collateral transfers, funding, interest, partial liquidation ladder, insurance fund,
bankruptcy socialization, derivatives, real custody, or exchange routing.

## Terminal feedback and scanner semantics

The account strip reports equity, available margin, margin used, gross exposure, realized P&L,
unrealized P&L, and starting bankroll from server snapshots. Position rows show direction,
leverage, notional, margin, liquidation price, P&L/ROI, protection, and close controls. Rank delta,
cash-line distance, podium gap, and projected payout are derived only from authoritative
leaderboard and payout snapshots.

The Market Pulse ranks the bulk `GET /v1/markets` snapshot using genuine 24-hour change and
high/low range fields. It labels top mover, widest range, and upside leader; it does not invent
volume, order-flow, or short-window momentum when the provider has not supplied those fields. The
bulk query refreshes the watchlist periodically, while only the selected market receives the
high-frequency realtime subscription.
