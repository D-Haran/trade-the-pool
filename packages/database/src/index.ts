import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export * from './schema.js';
export type Database = PostgresJsDatabase<typeof schema>;
export function createDatabase(url: string): { db: Database; client: postgres.Sql } {
  const client = postgres(url);
  return { db: drizzle(client, { schema }), client };
}
