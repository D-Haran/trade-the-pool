import postgres from 'postgres';

const client = postgres(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const [tournament] =
  await client`INSERT INTO tournaments (slug, name, description, status, simulated_pool, simulated_entry_contribution, opens_at, entry_closes_at, trading_closes_at, max_entries_per_user) VALUES ('dev-pool', 'Development Pool', 'Seed tournament for local development.', 'OPEN', 10000.00, 25.00, now(), now() + interval '7 days', now() + interval '14 days', 3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
for (const [id, displayName] of [
  ['00000000-0000-4000-8000-000000000001', 'Ada Trader'],
  ['00000000-0000-4000-8000-000000000002', 'Grace Markets'],
  ['00000000-0000-4000-8000-000000000003', 'Linus Ledger'],
] as const)
  await client`
    INSERT INTO users (id, display_name) VALUES (${id}, ${displayName})
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
  `;
console.log(`Seeded tournament ${tournament.id}`);
await client.end();
