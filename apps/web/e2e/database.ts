import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { E2E } from './fixtures';

const applicationDatabaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@127.0.0.1:5432/trade_the_pool';
const applicationRedisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

function isolatedDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const url = new URL(applicationDatabaseUrl);
  const applicationName = decodeURIComponent(url.pathname.slice(1));
  url.pathname = `/${applicationName}_e2e`;
  return url.toString();
}

export const databaseUrl = isolatedDatabaseUrl();

function isolatedRedisUrl(): string {
  if (process.env.E2E_REDIS_URL) return process.env.E2E_REDIS_URL;
  const url = new URL(applicationRedisUrl);
  url.pathname = '/15';
  return url.toString();
}

export const redisUrl = isolatedRedisUrl();

export async function prepareE2eDatabase(): Promise<void> {
  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseName))
    throw new Error('E2E database name contains unsupported characters');
  const adminUrl = new URL(applicationDatabaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString());
  const [existing] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists
  `;
  if (!existing?.exists) await admin`CREATE DATABASE ${admin(databaseName)}`;
  await admin.end();

  const sql = postgres(databaseUrl, { max: 1 });
  const migrationDirectory = [
    resolve(process.cwd(), '../../packages/database/drizzle'),
    resolve(process.cwd(), 'packages/database/drizzle'),
  ].find(existsSync);
  if (!migrationDirectory) throw new Error('Unable to locate database migrations');
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const migration of migrations)
    await sql.unsafe(await readFile(resolve(migrationDirectory, migration), 'utf8'));
  await sql.end();
}

export async function cleanFixtures(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM account_ledger_entries WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM fill_audits WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM fills WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM positions WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM orders WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM tournament_entry_fee_tiers WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM tournament_settlement_marks WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM tournaments WHERE id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM user_wallets WHERE user_id IN (${E2E.userId}, ${E2E.otherUserId})`;
  await sql`DELETE FROM users WHERE id IN (${E2E.userId}, ${E2E.otherUserId})`;
}
