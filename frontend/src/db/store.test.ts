import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIdentity, LedgerDB } from './database';
import { createLocalStore, initializeStore } from './store';
import { registerStock } from './ledger';

let database: LedgerDB;
beforeEach(() => {
  database = new LedgerDB(`store-test-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await database.delete();
});

describe('local store lifecycle', () => {
  it('creates a named guest store with a permanent ID and no account', async () => {
    await initializeStore(database);
    expect(await database.metadata.get('store')).toBeUndefined();
    const identity = await getIdentity(database);
    const store = await createLocalStore('  Chika Family Stores  ', database);
    expect(store).toMatchObject({ id: identity.storeId, name: 'Chika Family Stores' });
    await registerStock('Rice', 'mudu', '5', 10000, crypto.randomUUID(), database);
    const name = database.name;
    database.close();
    database = new LedgerDB(name);
    await initializeStore(database);
    expect((await database.metadata.get('store'))?.value).toEqual(store);
    expect(await getIdentity(database)).toEqual(identity);
    expect(await database.metadata.get('account')).toBeUndefined();
    expect((await database.outbox.toArray())[0]).toMatchObject({
      storeId: store.id,
      status: 'pending',
    });
  });
  it('gives separate stores unique IDs even when their names match', async () => {
    const other = new LedgerDB(`store-test-${crypto.randomUUID()}`);
    try {
      const a = await createLocalStore('Corner shop', database);
      const b = await createLocalStore('Corner shop', other);
      expect(a.name).toBe(b.name);
      expect(a.id).not.toBe(b.id);
    } finally {
      await other.delete();
    }
  });
  it('requires a valid name and never replaces an existing store', async () => {
    for (const name of [' ', 'x'.repeat(161)])
      await expect(createLocalStore(name, database)).rejects.toThrow();
    expect(await database.metadata.get('store')).toBeUndefined();
    const store = await createLocalStore('First shop', database);
    await expect(createLocalStore('Another shop', database)).rejects.toThrow('already');
    expect((await database.metadata.get('store'))?.value).toEqual(store);
  });
  it('requires store setup before recording new ledger entries', async () => {
    await expect(
      registerStock('Rice', 'mudu', '1', 10000, crypto.randomUUID(), database),
    ).rejects.toThrow('Create your store');
    expect(await database.products.count()).toBe(0);
    expect(await database.outbox.count()).toBe(0);
  });
  it('adopts an older guest ledger in place without changing its queue, identity or draft', async () => {
    await createLocalStore('Original', database);
    await registerStock('Rice', 'mudu', '5', 10000, crypto.randomUUID(), database);
    await database.metadata.delete('store'); // An installation from before named stores.
    await database.metadata.put({ key: 'sale-draft', value: { customer: 'Mama Chika' } });
    const identity = await getIdentity(database),
      queue = await database.outbox.toArray();
    await initializeStore(database);
    expect((await database.metadata.get('store'))?.value).toMatchObject({
      id: identity.storeId,
      name: 'Doris Foods',
    });
    expect(await database.outbox.toArray()).toEqual(queue);
    expect(await getIdentity(database)).toEqual(identity);
    expect((await database.metadata.get('sale-draft'))?.value).toEqual({ customer: 'Mama Chika' });
    expect(await database.productUnits.count()).toBe(1);
  });
  it('uses an existing account’s store name when adopting an older installation', async () => {
    const identity = await getIdentity(database);
    const account = { ...identity, storeName: 'Nnéka’s market', restoreReady: true, writer: false };
    await database.metadata.put({ key: 'account', value: account });
    await initializeStore(database);
    expect((await database.metadata.get('store'))?.value).toMatchObject({
      id: identity.storeId,
      name: account.storeName,
    });
    expect((await database.metadata.get('account'))?.value).toEqual(account);
  });
});
