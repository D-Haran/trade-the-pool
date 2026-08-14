import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { addMoney, moneyToString, parseMoney } from '@trade-the-pool/shared';
import { createTournamentEntry } from './index.js';

const url = process.env.DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('entry creation concurrency (PostgreSQL)', () => {
  const connection = url ? createDatabase(url) : null;
  const client = connection?.client ?? null;
  const database = connection?.db ?? null;
  let tournamentId = '';
  let userIds: string[] = [];
  beforeAll(async () => {
    if (!client) return;
    const [tournament] =
      await client`INSERT INTO tournaments (slug, name, description, status, simulated_pool, simulated_entry_contribution, entry_closes_at, max_entries_per_user) VALUES ('test-concurrency-${Date.now()}', 'Test', 'Test', 'OPEN', 50000.00, 25.00, now() + interval '1 day', 20) RETURNING id`;
    tournamentId = tournament.id;
    userIds = await Promise.all(
      Array.from(
        { length: 10 },
        async (_, index) =>
          (
            await client`INSERT INTO users (display_name) VALUES (${'Concurrent ' + index}) RETURNING id`
          )[0].id,
      ),
    );
  });
  it('serializes ten concurrent entrants and preserves each snapshot', async () => {
    if (!database) return;
    const entries = await Promise.all(
      userIds.map((userId) => createTournamentEntry(database, tournamentId, userId)),
    );
    expect(new Set(entries.map((entry) => entry.startingBankroll)).size).toBe(10);
    expect(entries.map((entry) => entry.startingBankroll).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) =>
        moneyToString(addMoney(parseMoney('50000.00'), parseMoney(`${index * 25}.00`))),
      ),
    );
    expect(entries.at(-1)?.updatedPool).toBe('50250.00');
  });
  afterAll(async () => {
    if (client) {
      await client`DELETE FROM tournament_entries WHERE tournament_id = ${tournamentId}`;
      await client`DELETE FROM tournaments WHERE id = ${tournamentId}`;
      await client`DELETE FROM users WHERE id = ANY(${userIds})`;
      await client.end();
    }
  });
});
