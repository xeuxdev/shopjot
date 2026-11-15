import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg, { type PoolClient } from 'pg';

// Opt in with a dedicated test/development URL. Every fixture is rolled back.
describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL ledger constraints', () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let client: PoolClient;
  let storeId: string;
  let otherStoreId: string;
  let customerId: string;
  let saleId: string;
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    const ownerId = crypto.randomUUID();
    storeId = crypto.randomUUID();
    otherStoreId = crypto.randomUUID();
    customerId = crypto.randomUUID();
    saleId = crypto.randomUUID();
    await client.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      ownerId,
      `${ownerId}@example.test`,
      'fixture-only',
    ]);
    await client.query(
      'INSERT INTO stores (id, owner_user_id, name) VALUES ($1, $3, $4), ($2, $3, $4)',
      [storeId, otherStoreId, ownerId, 'Test store'],
    );
    await client.query(
      'INSERT INTO customers (id, store_id, name, normalized_name) VALUES ($1, $2, $3, $4)',
      [customerId, storeId, 'Mama Chika', 'mama chika'],
    );
    await client.query(
      'INSERT INTO sales (id, store_id, customer_id, total_kobo, occurred_at) VALUES ($1, $2, $3, 1000, now())',
      [saleId, storeId, customerId],
    );
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });
  afterAll(async () => {
    await pool.end();
  });
  it('rejects a customer reference from another store', async () => {
    await expect(
      client.query(
        'INSERT INTO sales (id, store_id, customer_id, total_kobo, occurred_at) VALUES ($1, $2, $3, 1000, now())',
        [crypto.randomUUID(), otherStoreId, customerId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('rejects negative sale totals', async () => {
    await expect(
      client.query(
        'INSERT INTO sales (id, store_id, customer_id, total_kobo, occurred_at) VALUES ($1, $2, $3, -1, now())',
        [crypto.randomUUID(), storeId, customerId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects zero-value payment events', async () => {
    await expect(
      client.query(
        'INSERT INTO payments (id, store_id, sale_id, amount_kobo, received_at) VALUES ($1, $2, $3, 0, now())',
        [crypto.randomUUID(), storeId, saleId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('enforces store-and-operation idempotency uniqueness', async () => {
    const operationId = crypto.randomUUID(),
      deviceId = crypto.randomUUID();
    const query =
      'INSERT INTO processed_sync_operations (store_id, operation_id, device_id, operation_type, result) VALUES ($1, $2, $3, $4, $5)';
    await client.query(query, [storeId, operationId, deviceId, 'sale.create', '{}']);
    await expect(
      client.query(query, [storeId, operationId, deviceId, 'sale.create', '{}']),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
