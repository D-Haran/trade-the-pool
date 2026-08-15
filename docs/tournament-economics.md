# Tournament economics and scheduling

This phase models simulated tournament economics only. Entry fees, prize pools, platform
allocations, payout projections, and rakeback are game inputs; they are not money movement,
revenue accounting, or payout execution.

## Scheduled lifecycle

Every tournament has four required, ordered timestamps:

```text
registrationOpensAt <= tradingStartsAt < entryClosesAt <= tradingClosesAt
```

The server derives the active scheduled phase at request/order time:

1. `DRAFT` before registration opens;
2. `REGISTRATION_OPEN` after registration opens and before trading starts;
3. `TRADING_ACTIVE` from trading start until entry close;
4. `ENTRY_CLOSED` from entry close until trading close;
5. `TRADING_CLOSED` at the trading-close boundary.

`FINALIZING`, `COMPLETED`, and `CANCELLED` are explicit terminal workflow states. A persisted
`TRADING_CLOSED` state is also respected as an administrative stop. No participant threshold is
used: trading starts at the configured time even with zero entries. Registration can precede
trading, and entry creation can continue after trading begins. At entry close, new entries stop
while existing accounts remain tradable until trading close.

## Bankroll and prize-pool concepts

- **Prize Pool** is the tournament's simulated reward pool.
- **Base Bankroll** is a fixed simulated amount configured for the tournament.
- **New Entry Bankroll** is `baseBankroll + currentPrizePool` at authoritative entry creation.
- **Starting Bankroll** is the immutable snapshot assigned to one entry.

Prize-pool growth never upgrades an existing entry. Ranking remains absolute dollar P&L:

```text
score = currentEquity - startingBankroll
```

Every entry persists its user entry number, global tournament entry number, entry price, prize
pool before entry, prize contribution, platform allocation, future reward allocation, rakeback,
base-bankroll snapshot, and starting bankroll. A PostgreSQL trigger prevents those historical
economics fields from being updated.

## Entry fee tiers and atomic creation

Fee tiers are normalized in `tournament_entry_fee_tiers`. A tier has an inclusive lower prize-pool
bound, an exclusive upper bound (or no upper bound for the final tier), and exact entry/allocation
amounts. Domain validation requires contiguous ordered thresholds from zero through an unbounded
final tier, no gaps or overlaps, and:

```text
entryFee = prizePoolContribution + platformFee + futureRewardAllocation
```

The client cannot submit a contribution or pay an arbitrary amount for more bankroll. The server
selects the fee tier solely from the locked current prize pool.

Entry creation locks the tournament row with `SELECT ... FOR UPDATE`, then atomically snapshots the
fee tier and bankroll inputs, inserts the entry and initial ledger record, adds the configured
prize contribution, and commits. This lock serializes concurrent entrants across fee thresholds.
The global tournament entry number records that authoritative order; the existing per-user entry
number remains the account label used by the UI.

## Payout projection

Payout configuration is separate from leaderboard ranking. Direct position allocations support
first, second, third, or other exact positions. An optional additional cash-line bucket can target
a percentage of entries. Allocation basis points may not exceed 10,000 in total.

`projectPayouts` uses exact cents to return the projected first, second, and third prizes, each
additional paid position, current cash line, paid entry count/percentage, allocated amount, and
unallocated amount. Additional-bucket remainder cents are distributed deterministically by rank.
React displays this server projection and never recalculates authoritative payouts.

## Entry caps and rakeback experiment

`maxEntriesPerUser` remains a required tournament setting and is displayed to users. Every entry
has independent positions and accounting. More independent entries are the only supported way to
increase tournament exposure.

Optional rakeback bands apply a basis-point rebate to the snapshotted platform allocation for the
first configured groups of entries. Rakeback is disabled in the product templates. When enabled
in simulation it cannot exceed platform allocation and never changes starting bankroll, fills,
P&L, equity, or rank.

## Development templates

The seed contains two deliberately concentrated formats:

- **Daily Pool:** $1,000 base bankroll, small initial simulated prize pool, short duration.
- **Weekend Pool:** $2,500 base bankroll, larger initial simulated prize pool, longer duration.

Both use the curated multi-asset paper market and server-authoritative trading rules. Their
fee/payout values are development assumptions, not final business economics.
