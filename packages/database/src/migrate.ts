import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const client = postgres(
  process.env.DATABASE_URL ??
    'postgres://trade_the_pool:trade_the_pool@localhost:5432/trade_the_pool',
);
const sql = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle/0000_domain_foundation.sql'),
  'utf8',
);
await client.unsafe(sql);
await client.end();
