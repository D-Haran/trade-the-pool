import postgres from 'postgres';
import { createClient } from 'redis';
import { cleanFixtures, databaseUrl, redisUrl } from './database';
import { E2E } from './fixtures';

export default async function globalTeardown(): Promise<void> {
  const sql = postgres(databaseUrl);
  await cleanFixtures(sql);
  await sql.end();
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  await redis.del([
    `projection:tournament:${E2E.tournamentId}:leaderboard:v1`,
    `projection:tournament:${E2E.completedTournamentId}:leaderboard:v1`,
  ]);
  await redis.quit();
}
