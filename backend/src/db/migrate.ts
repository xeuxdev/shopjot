import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { resolve } from 'node:path';
const pool = new pg.Pool({
  connectionString:
    process.env.DIRECT_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://doris:doris_local_only@localhost:5437/doris_foods',
  enableChannelBinding: true,
});
if (process.env.NODE_ENV === 'production' && !process.env.DIRECT_DATABASE_URL)
  throw new Error('DIRECT_DATABASE_URL is required for production migrations.');
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(742619351)');
  await migrate(drizzle(client), {
    migrationsFolder: resolve('drizzle'),
  });
  console.log('Database migrations applied.');
} finally {
  await client.query('SELECT pg_advisory_unlock(742619351)').catch(() => undefined);
  client.release();
  await pool.end();
}
