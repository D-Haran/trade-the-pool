# Tournament simulator

`packages/simulator` is an in-memory, deterministic game-mechanics simulator. It depends on the
shared fixed-precision primitives and reusable tournament economics in `trading-engine`; it does
not depend on React, HTTP, PostgreSQL, or Redis.

## Running experiments

```bash
pnpm simulate --runs 10000 --players 120 --seed 42 --template daily \
  --output simulation-results
```

Supported CLI inputs are `--runs`, `--players`, `--seed`, `--template daily|weekend`, `--config`
for a JSON override file, and `--output`. Each run writes:

- JSON containing the seed, complete normalized configuration, aggregate metrics, diagnostics,
  and per-tournament metrics;
- CSV with one row per tournament;
- a human-readable Markdown report also printed to the console.

The same seed, configuration, population, and price path reproduce the same economic and ranking
results. Performance timing fields are naturally wall-clock dependent.

## Population and decisions

The population includes random, weak, average, skilled, high-risk, late-entry optimizer,
early-entry optimizer, and re-entry optimizer archetypes. Attributes include skill, risk
tolerance, entry preference, re-entry propensity, trade frequency, concentration, directional
accuracy, and holding period.

Entry probability combines current server-rule entry price, available new-entry bankroll, time
remaining, competition, prize-pool growth, and existing personal entries. Re-entry events are put
back into the time-ordered arrival queue, so a later independent entry receives the fee and pool
snapshot at its serialized simulated arrival—not at its user's first arrival.

Arrival models are uniform, early-heavy, late-heavy, social/viral bursts, and pool-size-sensitive.
The optional network model increases entry probability as prize pool, participants, and elapsed
time grow. Its sensitivities are configuration inputs rather than fixed product claims.

## Prices and trading

Seeded fixed-point BTC/ETH/SOL paths support low-volatility trend, high-volatility trend,
range/chop, reversal, and shock/event regimes. Stochastic return generation uses a seeded model;
path prices and score settlement are fixed-point integers. Synthetic traders make long-only
decisions against those paths, pay standardized trading costs, and share the same price/execution
assumptions within a tournament. Ranking remains absolute dollar P&L.

`HistoricalPriceReplaySource` defines the future adapter for historical BTC/ETH/SOL paths. No
historical provider is bundled in this phase.

## Metrics and diagnostics

Each tournament records final prize pool, entrants, unique users, total entries, entries per user,
winner arrival time/percentile, winner bankroll/P&L/return, podium and cash-line entry times,
platform allocation, net fee revenue, prize growth, and rakeback.

Batch reports calculate overlapping winner-timing windows (first 10%, first quartile, middle 50%,
final quartile, final 10%), expected placement and competition EV by early/middle/late entry,
skill correlations with placement/win/cash, multi-entry winner advantage, and high-risk strategy
dominance. Warnings flag extreme late dominance, weak early placement, disproportionate risk or
re-entry wins, participation stalls, and effectively mandatory re-entry.

These diagnostics compare mechanics under explicit assumptions. They do not prove balance or
claim that synthetic behavior represents real traders. Parameters should be swept across base
bankroll, initial pool, duration, entry close, tiers, contribution split, entry cap, payout,
rakeback, and position limits, then calibrated against observed alpha data.
