import postgres from 'postgres';
import { E2E } from './fixtures';

export const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@127.0.0.1:5432/trade_the_pool';

export async function cleanFixtures(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM account_ledger_entries WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM fills WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM positions WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM orders WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId}))`;
  await sql`DELETE FROM tournament_entries WHERE tournament_id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM tournaments WHERE id IN (${E2E.tournamentId}, ${E2E.completedTournamentId})`;
  await sql`DELETE FROM users WHERE id IN (${E2E.userId}, ${E2E.otherUserId})`;
}
