# Market data and execution authority

Trade the Pool uses real public crypto markets as inputs and produces only simulated paper fills.
One backend `MarketDataProvider` boundary supplies the trading engine, HTTP API, WebSocket fanout,
and account projections. Browsers never connect to an upstream provider and never provide a price,
timestamp, balance, P&L value, or trigger decision.

## Source responsibilities

| Internal responsibility                                                 | Live source                              | Notes                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Exchange last price, 24h statistics, minute+ OHLC, Level-2 book, trades | Kraken WebSocket v2 and public OHLC REST | The visible book is venue-specific and is never presented as consolidated.                    |
| 1s/5s/15s/30s candles                                                   | Kraken WebSocket v2 matched trades       | Aggregated centrally; never interpolated or generated from ticker motion in live mode.        |
| Independent comparison                                                  | Coinbase Advanced Trade public ticker    | Used only for integrity/deviation checks; it does not silently become execution authority.    |
| `AUTHORITATIVE_MARK`                                                    | Pyth Hermes price stream                 | Requires a server-side API key and an explicitly configured feed ID for every enabled market. |
| Test and local fake mode                                                | `DeterministicMarketPriceSource`         | Network-free, exact, controllable fixtures; never an implicit fallback from live mode.        |

The canonical registry contains BTC, ETH, SOL, XRP, DOGE, LINK, AVAX, ADA, SUI, AAVE, NEAR, and
LTC against USD. The registry owns display metadata, precision, provider mappings, enablement,
ordering, and leverage caps. Kraken, Coinbase, and Pyth identifiers are translated only inside the
provider package. Upstream connections are shared per API process rather than created per browser.
Raw ticks remain bounded in process memory and are not written to PostgreSQL. Compact completed
5s/15s/30s OHLCV bars are durable PostgreSQL records; Redis is never their source of truth.

## Processing flow

```text
Kraken WS/REST ---- primary exchange state, candles, book, trades --┐
Coinbase WS ------- independent comparison ------------------------┼─ MarketDataService
Pyth Hermes ------- authoritative mark -----------------------------┘       │
                                                                            ├─ trading engine
                                                                            ├─ normalized REST
                                                                            └─ scoped WebSocket fanout
```

Prices and quantities enter the backend as decimal lexemes and are converted to the repository's
fixed-precision `bigint` types. Accounting never uses binary floating point. The chart library is a
display-only boundary and converts serialized values to numbers only when rendering.

## Freshness and availability

Freshness thresholds are centralized in validated environment configuration:

- the authoritative mark is `LIVE` through `MARKET_AUTHORITATIVE_DELAYED_MS`, then `DELAYED`, and
  becomes `STALE` after `MARKET_AUTHORITATIVE_STALE_MS`;
- comparison prices older than `MARKET_COMPARISON_STALE_MS` do not participate in integrity checks;
- exchange and order-book ages have separate thresholds because sparse trades, book updates, and
  oracle marks have different liveness characteristics;
- timestamps too far in the future and malformed/non-positive fixed-point values are discarded;
- a fresh comparison price differing from the mark by more than `MARKET_MAX_DEVIATION_BPS` makes
  that symbol `DEGRADED`.

The market freshness states are `LIVE`, `DELAYED`, `STALE`, `RECONNECTING`, `UNAVAILABLE`, and
`DEGRADED`. Application availability is separately exposed as `ACTIVE`, `DEGRADED`, or `PAUSED`
(`DISABLED` remains available for registry policy). New orders and conditional evaluation are
allowed only for execution-eligible authoritative snapshots. `STALE`, `RECONNECTING`,
`UNAVAILABLE`, and `DEGRADED` fail closed. Existing account/history reads remain available.

Provider sockets reconnect with bounded exponential backoff and jitter. A connected socket alone
does not make a market live: the adapter must resubscribe and the service must receive a valid,
fresh update. Provider health tracks connection state, last message, last valid price, last book
and trade, reconnect count, book-resync count, and the last sanitized error.

Failures are isolated by responsibility. A corrupt or stale Kraken book is discarded and
resnapshotted while a healthy authoritative mark can still power paper execution. A Pyth failure
pauses new execution even if Kraken charts continue moving. No browser price, ancient cache,
random value, or unvalidated venue switch is used as a fallback.

## Order book and candles

The Kraken book begins from a snapshot and then applies ordered incremental updates. Zero quantity
removes a level. Every update is sorted/truncated using exact prices and validated with Kraken's
CRC32 top-ten checksum. A mismatch clears the local book, reports `RECONNECTING`, and forces a new
subscription/snapshot; knowingly corrupt depth is never served as live.

Minute-and-above (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`) historical candles come from Kraken OHLC
REST in live mode. The normalized provider range is cached with timeframe-aware 15-second to
15-minute TTLs and identical concurrent fetches are deduplicated. The API serves the latest or an
exclusive `before` cursor in chronological order. The client initially asks for 600 bars and
lazily requests older chunks. Kraken's public OHLC window is currently about 720 recent bars, so
scroll-back stops honestly when that source window is exhausted. Realtime
Kraken 1-minute OHLC updates merge by UTC bucket timestamp, replacing an overlapping historical
candle instead of appending a duplicate. Kraken permits one OHLC interval subscription per symbol;
larger visible current intervals therefore advance from genuine Kraken ticker events after their
REST bootstrap. Unsupported or missing periods are not synthesized. Volume is present only when
supplied upstream. The bounded deterministic provider remains intentionally artificial and reports
unavailable volume.

Sub-minute candles (`1s`, `5s`, `15s`, `30s`) are built server-side from normalized genuine
Kraken matched trades. One-second buckets use `floor(exchange timestamp / 1000)` on UTC epoch
boundaries. Open is the first trade, high/low are the extrema, close is the last trade, and volume
is the exact sum of Kraken base quantities. Older trades arriving after the active second are
discarded rather than rewriting already-published history. Once a genuine seed price exists, a
healthy but trade-free second carries the previous close as OHLC with zero volume; it never invents
movement. Carry-forward stops when the trade feed is stale or disconnected.

The canonical 1s stream is the sole child source for UTC-aligned 5s, 15s, and 30s bars. A
250-millisecond service clock advances/finalizes UTC boundaries without waiting for a future
trade. Derived open/high/low/close/volume come from the first, extrema, final, and summed 1s child
values. Kraken's genuine trade-subscription snapshot supplies a small startup bootstrap where
available; it is not presented as deep history.

Completed 5s/15s/30s bars are upserted by `(symbol, interval, timestamp)`. Central retention keeps
24 hours of 5s and seven days of 15s/30s bars. The canonical 1s buffer remains process-local for two
hours. Startup restores recent completed bars and seeds carry-forward across a restart only when
the last durable close remains inside the exchange-stale window; longer downtime remains an honest
gap. Persisted, in-memory, and active bars reconcile by timestamp. PostgreSQL never stores raw
ticks. Fake/CI mode exposes the same intervals with explicit deterministic `SIMULATED` data.

## Execution and settlement policy

The execution reference for market, limit, stop-market, take-profit, and stop-loss decisions is
always the server's `AUTHORITATIVE_MARK`:

```text
reference price = authoritative mark
paper fill       = reference price ± configured spread ± deterministic simulated impact/slippage
```

The Kraken last trade shown on the chart may differ slightly from the mark. The order book is
informational; this phase does not model venue queues, partial fills, or maker priority.

At tournament close, the settlement worker first persists `TRADING_CLOSED` and expires remaining
open/conditional orders, then obtains a complete fresh mark set. If any mark is unavailable, stale,
or degraded, the explicit closed state remains and the worker retries without changing account
values. With valid marks, one PostgreSQL transaction stores one immutable mark per supported
symbol, computes exact account equity/P&L, and changes the tournament to `COMPLETED`. Completed
account and leaderboard reads continue using the stored mark set, so final results cannot drift.
Retrying a completed settlement is idempotent and does not require the provider to be online.

## API and operations

Normalized REST endpoints are:

- `GET /v1/markets`
- `GET /v1/markets/:symbol`
- `GET /v1/markets/:symbol/candles?interval=1s|5s|15s|30s|1m|5m|15m|1h|4h|1d&limit=...&before=<ISO-8601>`
- `GET /v1/markets/:symbol/book?depth=...`
- `GET /v1/markets/:symbol/trades?limit=...`

The `market:<symbol>` WebSocket topic carries normalized price, book, bounded trade, and market
status events. Candles use `market:<symbol>:candles:<interval>` so a browser receives only its
active chart stream; a timeframe or market change unsubscribes the old topic. Clients bootstrap
from REST and resync after reconnect. `market.candle_status` reports a stale/unavailable
sub-minute trade feed without changing execution-mark health.

`GET /health/ready` reports nuanced market readiness without forcing process restarts for a
temporary venue outage. `GET /health/market-data` exposes sanitized provider/market health plus
component-to-provider provenance, canonical provider symbol mappings, sub-minute last-trade and
last-finalized times, bounded buffer sizes, aggregation lag, fanout subscriber, topic, delivery,
and latest-duration metrics. It never includes credentials or Pyth feed IDs. Market
snapshot responses also expose `dataMode` and the component provenance map so development clients
cannot mistake deterministic fixtures for upstream data.

## Configuration

`MARKET_DATA_MODE=fake` is the default development/CI mode. It has no network or credential
dependency and the terminal labels it `DEV DATA`; its deterministic book is labeled `SIMULATED`.
Production rejects fake mode at startup. Live mode validates all required settings at startup and
never silently falls back:

```bash
MARKET_DATA_MODE=live
PYTH_API_KEY=...
PYTH_FEED_ID_BTC_USD=...
PYTH_FEED_ID_ETH_USD=...
PYTH_FEED_ID_SOL_USD=...
# ...one PYTH_FEED_ID_<ASSET>_USD for every enabled registry market
```

The provider URLs and freshness/deviation thresholds are listed in `.env.example`. API keys and
feed configuration are server-only; no market secret is prefixed with `NEXT_PUBLIC_` or returned
through an API. Use current stable Pyth feed IDs for the intended environment rather than copying
an old example.

Current upstream protocol references:

- [Kraken WebSocket v2 book](https://docs.kraken.com/api/docs/websocket-v2/book/)
- [Kraken v2 book checksum guide](https://docs.kraken.com/api/docs/guides/spot-ws-book-v2/)
- [Coinbase Advanced Trade WebSocket channels](https://docs.cdp.coinbase.com/advanced-trade/docs/ws-channels)
- [Pyth Hermes price updates](https://docs.pyth.network/price-feeds/core/fetch-price-updates)
