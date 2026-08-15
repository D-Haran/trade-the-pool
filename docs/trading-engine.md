# Trading engine

This package implements server-authoritative paper trading for the canonical market registry. It
supports explicit long and simulated short positions, asset-specific leverage from 1x to 5x, and
deterministic liquidation without real assets or external exchange orders. PostgreSQL is the
durable source of truth. The in-memory market source is only an authoritative test/local price
provider and is never an accounting store.

## Precision and rounding

Cash, fees, notional, equity, and P&L are signed `bigint` minor units with a scale of 100
(cents), persisted as `numeric(20,2)`. Prices and asset quantities are `bigint` fixed-point
values with a scale of 100,000,000, persisted as `numeric(28,8)`. Authoritative accounting
never uses JavaScript `number` or binary floating point.

Parsing rejects excess precision. A buy derives quantity by division rounded down, so the
exact position can never exceed the requested dollar notional. Price-times-quantity,
percentage fees, price adjustments, weighted average price, and P&L settle with round-half-up
(halves away from zero). These rules live in `@trade-the-pool/shared` and are unit tested.

## Deterministic fills and fees

The centrally typed execution configuration defines allowed symbols, spread, fee rate,
maximum slippage, per-symbol simulated liquidity, maximum buy-order notional, optional
concentration limit, and stale-price threshold. V1 defaults are 5 bps spread, 10 bps fee,
and 20 bps maximum slippage.

For reference notional `N`, configured liquidity `L`, reference price `P`, spread bps `S`,
and maximum slippage bps `M`:

```text
spread adjustment   = roundHalfUp(P * S / 10,000)
slippage adjustment = roundHalfUp(P * M * min(N, L) / (10,000 * L))
BUY fill             = P + spread adjustment + slippage adjustment
SELL fill            = P - spread adjustment - slippage adjustment
```

Slippage is linear in notional-to-liquidity ratio and capped at `M`; there is no randomness.
Every fill records the reference/fill prices, both per-unit adjustments, exact quantity,
settled notional, fee, market source and timestamp, server timestamp, and per-entry execution
sequence. The sequence makes deterministic replay independent of timestamp ties.

Every new fill also creates a one-to-one durable `fill_audits` record in the same transaction. It
captures the user/entry/order identity, position before and after, explicit execution reason,
requested and filled quantity, leverage, entry basis, trusted and comparison marks with source and
receive timestamps, simulated costs, realized/open P&L, equity before/after, margin before/after,
and quantity before/after. Existing historical fills are not silently backfilled with invented
facts.

Fees are rounded to cents from fill notional. They are excluded from average entry price and
gross realized P&L, but always reduce cash through a dedicated `TRADING_FEE` ledger record.
Consequently equity includes all fee economics. API presentation may show gross realized P&L
and cumulative fees separately.

## Position and account accounting

Long and simulated-short positions use weighted-average fill-price cost basis. A symbol can have
one direction per entry at a time. Partial closes retain the average price of the remaining
quantity. Long P&L uses `(exit or mark - average entry) * quantity`; short P&L reverses the
subtraction. A fully closed position has zero quantity, zero average price, and zero unrealized
P&L.

Authoritative equity is always:

```text
cash + long marked value - short marked liability
```

Opening a short credits simulated sale proceeds and creates an equal marked liability; buying it
back debits cash. A leveraged long can therefore carry an explicit negative simulated financing
cash balance. Equity is still cash plus long assets minus short liabilities, so leverage changes
capital efficiency rather than multiplying P&L. Margin, pending-order reservations, the 5x gross
exposure ceiling, and liquidation are described in [`margin-risk.md`](margin-risk.md).

The entry's cached cash/P&L/equity columns are updated inside each order transaction.
`reconcileEntry` independently sums the ledger for expected cash, replays fills in execution
sequence for expected positions and realized P&L, marks open replayed positions, and compares
all values with persisted rows. It reports `FINANCIAL_INVARIANT_VIOLATION` with mismatch details
and never repairs state silently. A market move without an accounting refresh can deliberately
surface cached mark-to-market drift.

## Ledger, transactions, and idempotency

The application treats `account_ledger_entries` as append-only and exposes no unrestricted
mutation API. Entry creation inserts exactly one positive `ACCOUNT_INITIALIZED` record in the
same transaction as the entry and pool update; the migration backfills pre-existing entries
idempotently. Buys append a negative `TRADE_CASH_DEBIT` and negative `TRADING_FEE`. Sells append
a positive `TRADE_CASH_CREDIT` and negative `TRADING_FEE`. A uniqueness key on entry, ledger
type, reference type, and reference ID prevents duplicated fill cash effects.

Order execution locks the tournament-entry row with `SELECT ... FOR UPDATE`. Every order for
that entry therefore serializes before reading cash or position state, preventing overspending,
overselling, and lost average-cost updates. Order, fill, position, ledger, and entry-cache writes
share one PostgreSQL transaction.

`(entry_id, idempotency_key)` is unique in PostgreSQL. After acquiring the entry lock, the
engine returns the stored order/fill for an identical replay. Reusing the key with different
symbol, side, or request parameters raises `DUPLICATE_ORDER_CONFLICT`. Concurrent duplicates
cannot execute cash or position mutations twice.

Trigger evaluation and execution use the same validated snapshot. Before commit, the engine
recomputes account equity and proves that the before/after delta equals the fill's mark-to-fill
execution impact less its single fee. An unexplained transition raises
`FINANCIAL_INVARIANT_VIOLATION` and rolls back the order, fill, position, ledger, audit, and cached
account changes together.

## Order lifecycle and tradability

Trading is allowed from the configured `tradingStartsAt` boundary until (but excluding)
`tradingClosesAt`. The derived `TRADING_ACTIVE` and `ENTRY_CLOSED` phases are tradable;
`ENTRY_CLOSED` stops new tournament entries but deliberately permits trading until the deadline.
The engine uses only the provider's price and timestamp and rejects stale or future-dated
snapshots. In live mode that internal snapshot is the Pyth-backed `AUTHORITATIVE_MARK`, not the
Kraken last trade displayed by the chart. Abnormal comparison-feed deviation marks the symbol
degraded and blocks new execution. Limit, stop-market, take-profit, and stop-loss boundary checks
all use that same authoritative mark; stale/degraded ticks pause conditional processing.

Every professional order declares `OPEN` or `CLOSE`, `LONG` or `SHORT`, and `MARKET`, `LIMIT`, or
`STOP_MARKET`. Open orders use dollar notional; closes use exact quantity or integer basis-point
percentage. Take-profit and stop-loss exits are stored as server-owned close orders. Conditional
orders are selected by indexed symbol/status order, processed deterministically, locked again
inside their transaction, and filled only from an authoritative tick. A full close cancels any
remaining close siblings, giving attached protection OCO behavior. Open orders can be cancelled
explicitly and expire deterministically after tournament trading closes.

Tournament settlement first locks the tournament into `TRADING_CLOSED` and expires open orders.
It then obtains one fresh execution-eligible mark for every enabled registry market before its final write transaction, which
persists one immutable mark per symbol, freezes exact entry equity/P&L, and completes the
tournament atomically. If a mark is not trustworthy, the closed retry state remains but account
values do not change. Completed snapshots and leaderboards reuse the stored marks, and idempotent
settlement replay does not need a live feed.

There is no real money, blockchain, leverage above 5x, derivative contract, funding, or external
exchange order routing. Development market volume is unavailable and is returned as `null`, never
fabricated.
