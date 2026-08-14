# Initial 10,000-run economics baseline

Command:

```bash
pnpm simulate --runs 10000 --players 120 --seed 42 --template daily \
  --output /private/tmp/trade-the-pool-simulation
```

Configuration: Daily Pool template; $1,000 base bankroll; $500 initial prize pool; 120 synthetic
players; pool-size-sensitive arrivals with network effects; high-volatility trend price regime;
entry close at 85% of the tournament; three-entry user cap; rakeback disabled; absolute dollar
P&L ranking.

## Performance and participation

- Throughput: 1,496 tournaments/second on the validation machine.
- Average entrants/entries: 119.15.
- Average final prize pool: $1,453.19.
- Average net simulated platform allocation: $238.29.
- Average rakeback: $0.00.

## Winner timing

The timing windows intentionally overlap:

- First 10%: 35.05%.
- First quartile: 71.68%.
- Middle 50%: 27.74%.
- Final quartile: 0.58%.
- Final 10%: 0.32%.

This baseline does not show late-entry winner dominance. It shows the opposite: under the current
synthetic execution assumptions, additional trading opportunities strongly favor early entries.
That may be partly caused by the model allowing repeated deployment of the same notional across
more available trade windows, so the magnitude should not be treated as a product forecast.

## Skill, re-entry, and risk

- Skill/placement correlation: 0.0327.
- Skill/win correlation: -0.0301.
- Skill/cash correlation: -0.0175.
- Multi-entry user share: 11.45%.
- Multi-entry winner share: 23.15%.
- Average entries held by a winner: 1.25.
- High-risk entry share: 10.24%.
- High-risk winner share: 88.94%.

Two diagnostics fired: multi-entry users won disproportionately, and high-risk entries dominated
catastrophically. Skill barely predicted placement and was slightly negatively related to wins
and cashes. Under absolute dollar P&L, the simulated high-concentration strategy is therefore a
clear broken/suspicious mechanic in this baseline. The code working correctly is not evidence that
the economics are balanced.

## Parameters to test next

1. Reduce the position-concentration limit from 100% to 25%, 40%, and 60% while holding all other
   inputs constant.
2. Reduce the high-risk archetype's repeat deployment frequency and sweep trading costs/slippage
   to test whether variance remains dominant.
3. Sweep entry close from 60% through 90% of duration to measure the early-time advantage.
4. Sweep base bankroll and prize-pool contribution so late bankroll growth is larger relative to
   the fixed base.
5. Compare one-, two-, and three-entry caps and add optional early-entry rakeback only after the
   concentration problem is controlled.
6. Recalibrate skill and decision parameters against alpha observations before drawing product
   conclusions.
