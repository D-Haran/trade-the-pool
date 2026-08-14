import postgres from 'postgres';

const client = postgres(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);

const payoutConfig = {
  directPrizes: [
    { position: 1, basisPoints: 4000 },
    { position: 2, basisPoints: 2000 },
    { position: 3, basisPoints: 1000 },
  ],
  additionalCashLine: { percentileBasisPoints: 1000, allocationBasisPoints: 3000 },
};

const templates = [
  {
    slug: 'daily-pool',
    name: 'Daily Pool',
    description: 'A concentrated daily BTC, ETH, and SOL paper-trading tournament.',
    baseBankroll: '1000.00',
    initialPrizePool: '500.00',
    tradingStarts: "now() - interval '30 minutes'",
    entryCloses: "now() + interval '6 hours'",
    tradingCloses: "now() + interval '8 hours'",
  },
  {
    slug: 'weekend-pool',
    name: 'Weekend Pool',
    description: 'A larger, longer BTC, ETH, and SOL paper-trading tournament.',
    baseBankroll: '2500.00',
    initialPrizePool: '4000.00',
    tradingStarts: "now() - interval '1 hour'",
    entryCloses: "now() + interval '36 hours'",
    tradingCloses: "now() + interval '48 hours'",
  },
] as const;

for (const template of templates) {
  const [tournament] = await client.unsafe<[{ id: string }]>(
    `
    INSERT INTO tournaments
      (slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config, rakeback_config)
    VALUES
      ($1, $2, $3, 'TRADING_ACTIVE', $4, $5,
       now() - interval '1 hour', ${template.tradingStarts},
       ${template.entryCloses}, ${template.tradingCloses}, 3, $6, NULL)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_bankroll = EXCLUDED.base_bankroll,
      registration_opens_at = EXCLUDED.registration_opens_at,
      trading_starts_at = EXCLUDED.trading_starts_at,
      entry_closes_at = EXCLUDED.entry_closes_at,
      trading_closes_at = EXCLUDED.trading_closes_at,
      max_entries_per_user = EXCLUDED.max_entries_per_user,
      payout_config = EXCLUDED.payout_config,
      rakeback_config = EXCLUDED.rakeback_config,
      updated_at = now()
    RETURNING id
  `,
    [
      template.slug,
      template.name,
      template.description,
      template.baseBankroll,
      template.initialPrizePool,
      JSON.stringify(payoutConfig),
    ],
  );

  await client`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id = ${tournament.id}`;
  await client`
    INSERT INTO tournament_entry_fee_tiers
      (tournament_id, ordinal, min_prize_pool, max_prize_pool, entry_fee,
       prize_pool_contribution, platform_fee, future_reward_allocation)
    VALUES
      (${tournament.id}, 0, 0.00, 2500.00, 10.00, 8.00, 2.00, 0.00),
      (${tournament.id}, 1, 2500.00, 5000.00, 15.00, 12.00, 3.00, 0.00),
      (${tournament.id}, 2, 5000.00, 10000.00, 20.00, 16.00, 4.00, 0.00),
      (${tournament.id}, 3, 10000.00, 25000.00, 25.00, 20.00, 5.00, 0.00),
      (${tournament.id}, 4, 25000.00, NULL, 35.00, 28.00, 7.00, 0.00)
  `;
  console.log(`Seeded ${template.name} ${tournament.id}`);
}

for (const [id, displayName] of [
  ['00000000-0000-4000-8000-000000000001', 'Ada Trader'],
  ['00000000-0000-4000-8000-000000000002', 'Grace Markets'],
  ['00000000-0000-4000-8000-000000000003', 'Linus Ledger'],
] as const)
  await client`
    INSERT INTO users (id, display_name) VALUES (${id}, ${displayName})
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
  `;

await client.end();
