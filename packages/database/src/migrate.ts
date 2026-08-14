import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = postgres(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
const migrations = (await readdir(migrationDirectory))
  .filter((file) => file.endsWith('.sql'))
  .sort();
for (const migration of migrations) {
  const sql = await readFile(resolve(migrationDirectory, migration), 'utf8');
  await client.unsafe(sql);
}
await client.end();
