import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export function makeDatabase(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({
    connectionString: url ?? 'postgres://doris:doris_local_only@localhost:5437/doris_foods',
    max: 5,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
    enableChannelBinding: true,
  });
  // A dropped idle Neon connection must not crash the API; the next query reconnects.
  pool.on('error', () => {
    console.error('An idle database connection closed; the pool will reconnect.');
  });
  return { pool, db: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof makeDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
