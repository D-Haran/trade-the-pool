import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@trade-the-pool/database';
import { addMoney, moneyToString, parseMoney } from '@trade-the-pool/shared';
import { createTournamentEntry, DomainError } from './index.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool';
const connection = createDatabase(databaseUrl);
const { client, db } = connection;

type Fixture = { tournamentId: string; userIds: string[] };

async function createFixture(options: { users?: number; maxEntriesPerUser?: number } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [tournament] = await client`
    INSERT INTO tournaments
      (slug, name, description, status, simulated_pool, simulated_entry_contribution,
       entry_closes_at, max_entries_per_user)
    VALUES
      (${`integration-${suffix}`}, 'Integration test', 'Integration test fixture', 'OPEN',
       50000.00, 25.00, now() + interval '1 day', ${options.maxEntriesPerUser ?? 20})
    RETURNING id
  `;
  const userIds = await Promise.all(
    Array.from({ length: options.users ?? 10 }, (_, index) =>
      client`
        INSERT INTO users (display_name)
        VALUES (${`Integration ${suffix}-${index}`})
        RETURNING id
      `.then(([user]) => user.id),
    ),
  );
  return { tournamentId: tournament.id, userIds } satisfies Fixture;
}

async function removeFixture(fixture: Fixture) {
  await client`DELETE FROM account_ledger_entries WHERE entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id = ${fixture.tournamentId})`;
  await client`DELETE FROM tournament_entries WHERE tournament_id = ${fixture.tournamentId}`;
  await client`DELETE FROM tournaments WHERE id = ${fixture.tournamentId}`;
  await client`DELETE FROM users WHERE id = ANY(${client.array(fixture.userIds)}::uuid[])`;
}

async function withFixture<T>(
  options: { users?: number; maxEntriesPerUser?: number },
  callback: (fixture: Fixture) => Promise<T>,
) {
  const fixture = await createFixture(options);
  try {
    return await callback(fixture);
  } finally {
    await removeFixture(fixture);
  }
}

async function installFailureTrigger(kind: 'entry' | 'pool') {
  if (kind === 'entry') {
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION integration_fail_entry_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced entry insert failure'; END;
      $$;
      CREATE TRIGGER integration_fail_entry_insert_trigger
      BEFORE INSERT ON tournament_entries
      FOR EACH ROW EXECUTE FUNCTION integration_fail_entry_insert();
    `);
  } else {
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION integration_fail_pool_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced pool update failure'; END;
      $$;
      CREATE TRIGGER integration_fail_pool_update_trigger
      BEFORE UPDATE ON tournaments
      FOR EACH ROW EXECUTE FUNCTION integration_fail_pool_update();
    `);
  }
}

async function removeFailureTrigger(kind: 'entry' | 'pool') {
  const table = kind === 'entry' ? 'tournament_entries' : 'tournaments';
  const trigger =
    kind === 'entry'
      ? 'integration_fail_entry_insert_trigger'
      : 'integration_fail_pool_update_trigger';
  const functionName =
    kind === 'entry' ? 'integration_fail_entry_insert' : 'integration_fail_pool_update';
  await client.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
  await client.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
}

describe('tournament entry creation concurrency (PostgreSQL)', () => {
  it('serializes two concurrent entrants with sequential sequences and snapshots', async () => {
    await withFixture({ users: 2 }, async ({ tournamentId, userIds }) => {
      const entries = await Promise.all(
        userIds.map((userId) => createTournamentEntry(db, tournamentId, userId)),
      );
      expect(entries.map((entry) => entry.sequenceNumber).sort()).toEqual([1, 1]);
      expect(entries.map((entry) => entry.startingBankroll).sort()).toEqual([
        '50000.00',
        '50025.00',
      ]);
      expect(new Set(entries.map((entry) => entry.startingBankroll)).size).toBe(2);
      expect(entries.map((entry) => entry.updatedPool).sort()).toEqual(['50025.00', '50050.00']);
      const [ledger] = await client`
        SELECT count(*)::int AS count, sum(amount)::text AS amount
        FROM account_ledger_entries
        WHERE entry_id = ANY(${client.array(entries.map((entry) => entry.id))}::uuid[])
          AND type = 'ACCOUNT_INITIALIZED'
      `;
      expect(ledger).toEqual({ count: 2, amount: '100025.00' });
    });
  });

  it('allocates ten distinct bankroll snapshots and loses no pool increments', async () => {
    await withFixture({ users: 10 }, async ({ tournamentId, userIds }) => {
      const entries = await Promise.all(
        userIds.map((userId) => createTournamentEntry(db, tournamentId, userId)),
      );
      expect(entries.map((entry) => entry.sequenceNumber)).toEqual(Array(10).fill(1));
      expect(new Set(entries.map((entry) => entry.startingBankroll)).size).toBe(10);
      expect(entries.map((entry) => entry.startingBankroll).sort()).toEqual(
        Array.from({ length: 10 }, (_, index) =>
          moneyToString(addMoney(parseMoney('50000.00'), parseMoney(`${index * 25}.00`))),
        ),
      );
      expect(
        entries
          .map((entry) => entry.updatedPool)
          .sort()
          .at(-1),
      ).toBe('50250.00');
      const [tournament] = await client`
        SELECT simulated_pool FROM tournaments WHERE id = ${tournamentId}
      `;
      expect(tournament.simulated_pool).toBe('50250.00');
    });
  });

  it('enforces maxEntriesPerUser for concurrent entries from the same user', async () => {
    await withFixture({ users: 1, maxEntriesPerUser: 3 }, async ({ tournamentId, userIds }) => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => createTournamentEntry(db, tournamentId, userIds[0])),
      );
      const successes = results.filter((result) => result.status === 'fulfilled');
      const failures = results.filter((result) => result.status === 'rejected');
      expect(successes).toHaveLength(3);
      expect(failures).toHaveLength(7);
      expect(
        failures.every(
          (result) =>
            result.reason instanceof DomainError && result.reason.code === 'ENTRY_LIMIT_REACHED',
        ),
      ).toBe(true);
      expect(successes.map((result) => result.value.sequenceNumber).sort((a, b) => a - b)).toEqual([
        1, 2, 3,
      ]);
      const [tournament] = await client`
        SELECT simulated_pool FROM tournaments WHERE id = ${tournamentId}
      `;
      expect(tournament.simulated_pool).toBe('50075.00');
    });
  });

  it('rolls back the entry and pool when entry creation fails', async () => {
    await withFixture({ users: 1 }, async ({ tournamentId, userIds }) => {
      await installFailureTrigger('entry');
      try {
        await expect(createTournamentEntry(db, tournamentId, userIds[0])).rejects.toThrow(
          'forced entry insert failure',
        );
      } finally {
        await removeFailureTrigger('entry');
      }
      const [state] = await client`
        SELECT t.simulated_pool, count(e.id)::int AS entries
        FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
        WHERE t.id = ${tournamentId} GROUP BY t.id
      `;
      expect(state).toEqual({ simulated_pool: '50000.00', entries: 0 });
    });
  });

  it('rolls back the entry when the tournament pool update fails', async () => {
    await withFixture({ users: 1 }, async ({ tournamentId, userIds }) => {
      await installFailureTrigger('pool');
      try {
        await expect(createTournamentEntry(db, tournamentId, userIds[0])).rejects.toThrow(
          'forced pool update failure',
        );
      } finally {
        await removeFailureTrigger('pool');
      }
      const [state] = await client`
        SELECT t.simulated_pool, count(e.id)::int AS entries
        FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
        WHERE t.id = ${tournamentId} GROUP BY t.id
      `;
      expect(state).toEqual({ simulated_pool: '50000.00', entries: 0 });
    });
  });

  it('rolls back the entry and pool when initial ledger creation fails', async () => {
    await withFixture({ users: 1 }, async ({ tournamentId, userIds }) => {
      await client.unsafe(`
        CREATE OR REPLACE FUNCTION integration_fail_initial_ledger()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced initial ledger failure'; END;
        $$;
        CREATE TRIGGER integration_fail_initial_ledger_trigger
        BEFORE INSERT ON account_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION integration_fail_initial_ledger();
      `);
      try {
        await expect(createTournamentEntry(db, tournamentId, userIds[0])).rejects.toThrow(
          'forced initial ledger failure',
        );
      } finally {
        await client.unsafe(
          'DROP TRIGGER IF EXISTS integration_fail_initial_ledger_trigger ON account_ledger_entries',
        );
        await client.unsafe('DROP FUNCTION IF EXISTS integration_fail_initial_ledger()');
      }
      const [state] = await client`
        SELECT t.simulated_pool, count(e.id)::int AS entries
        FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id = t.id
        WHERE t.id = ${tournamentId} GROUP BY t.id
      `;
      expect(state).toEqual({ simulated_pool: '50000.00', entries: 0 });
    });
  });
});

afterAll(() => client.end());
