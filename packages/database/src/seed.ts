import postgres from 'postgres';
import { randomUUID } from 'node:crypto';

const client = postgres(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const [tournament] =
  await client`INSERT INTO tournaments (slug, name, description, status, simulated_pool, simulated_entry_contribution, opens_at, entry_closes_at, trading_closes_at, max_entries_per_user) VALUES ('dev-pool', 'Development Pool', 'Seed tournament for local development.', 'OPEN', 10000.00, 25.00, now(), now() + interval '7 days', now() + interval '14 days', 3) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
for (const displayName of ['Ada Trader', 'Grace Markets', 'Linus Ledger'])
  await client`INSERT INTO users (id, display_name) VALUES (${randomUUID()}, ${displayName}) ON CONFLICT DO NOTHING`;
console.log(`Seeded tournament ${tournament.id}`);
await client.end();
