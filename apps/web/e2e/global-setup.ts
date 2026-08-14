import postgres from 'postgres';
import { createClient } from 'redis';
import { cleanFixtures, databaseUrl } from './database';
import { E2E } from './fixtures';

export default async function globalSetup(): Promise<void> {
  const sql = postgres(databaseUrl);
  await cleanFixtures(sql);
  await sql`INSERT INTO users (id, display_name) VALUES (${E2E.userId}, 'E2E Trader'), (${E2E.otherUserId}, 'E2E Rival')`;
  await sql`
    INSERT INTO tournaments
      (id, slug, name, description, status, base_bankroll, current_prize_pool, entry_contribution,
       opens_at, entry_closes_at, trading_closes_at, max_entries_per_user)
    VALUES
      (${E2E.tournamentId}, ${E2E.slug}, 'Open Championship',
       'A deterministic tournament for browser validation.', 'OPEN', 10000.00, 0.00, 25.00,
       now(), now() + interval '1 day', now() + interval '2 days', 3),
      (${E2E.completedTournamentId}, ${E2E.completedSlug}, 'Completed Championship',
       'A completed deterministic tournament.', 'COMPLETED', 10000.00, 1500.00, 25.00,
       now() - interval '3 days', now() - interval '2 days', now() - interval '1 day', 3)
  `;
  await sql.end();
  const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
  await redis.connect();
  await redis.del([
    `projection:tournament:${E2E.tournamentId}:leaderboard:v1`,
    `projection:tournament:${E2E.completedTournamentId}:leaderboard:v1`,
  ]);
  await redis.quit();
}
