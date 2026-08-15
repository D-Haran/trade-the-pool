import postgres from 'postgres';
import { createClient } from 'redis';
import { cleanFixtures, databaseUrl, redisUrl } from './database';
import { E2E } from './fixtures';

export default async function globalSetup(): Promise<void> {
  const sql = postgres(databaseUrl);
  await cleanFixtures(sql);
  await sql`INSERT INTO users (id, display_name) VALUES (${E2E.userId}, 'E2E Trader'), (${E2E.otherUserId}, 'E2E Rival')`;
  await sql`
    INSERT INTO tournaments
      (id, slug, name, description, status, base_bankroll, current_prize_pool,
       registration_opens_at, trading_starts_at, entry_closes_at, trading_closes_at,
       max_entries_per_user, payout_config)
    VALUES
      (${E2E.tournamentId}, ${E2E.slug}, 'Open Championship',
       'A deterministic tournament for browser validation.', 'TRADING_ACTIVE', 10000.00, 0.00,
       now() - interval '2 hours', now() - interval '1 hour',
       now() + interval '1 day', now() + interval '2 days', 3,
       ${JSON.stringify({
         directPrizes: [
           { position: 1, basisPoints: 5000 },
           { position: 2, basisPoints: 3000 },
           { position: 3, basisPoints: 2000 },
         ],
       })}),
      (${E2E.completedTournamentId}, ${E2E.completedSlug}, 'Completed Championship',
       'A completed deterministic tournament.', 'COMPLETED', 10000.00, 1500.00,
       now() - interval '4 days', now() - interval '3 days',
       now() - interval '2 days', now() - interval '1 day', 3,
       ${JSON.stringify({ directPrizes: [{ position: 1, basisPoints: 10000 }] })})
  `;
  await sql`
    INSERT INTO tournament_entry_fee_tiers
      (tournament_id, ordinal, min_prize_pool, max_prize_pool, entry_fee,
       prize_pool_contribution, platform_fee, future_reward_allocation)
    VALUES
      (${E2E.tournamentId}, 0, 0.00, 25.00, 30.00, 25.00, 5.00, 0.00),
      (${E2E.tournamentId}, 1, 25.00, NULL, 40.00, 30.00, 10.00, 0.00),
      (${E2E.completedTournamentId}, 0, 0.00, NULL, 30.00, 25.00, 5.00, 0.00)
  `;
  await sql.end();
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  const rateKeys = await redis.keys('rate:*');
  if (rateKeys.length) await redis.del(rateKeys);
  await redis.del([
    `projection:tournament:${E2E.tournamentId}:leaderboard:v1`,
    `projection:tournament:${E2E.completedTournamentId}:leaderboard:v1`,
  ]);
  await redis.quit();
}
