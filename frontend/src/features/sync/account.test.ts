import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getIdentity, LedgerDB } from '../../db/database';
import { createLocalStore } from '../../db/store';
import { registerStock } from '../../db/ledger';
import { connectAccount } from './account';
import { runSync } from './engine';

let database: LedgerDB;
beforeEach(() => {
  database = new LedgerDB(`account-test-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await database.delete();
});
const email = 'owner@example.test',
  password = 'test-password-123';
async function response(storeId?: string) {
  const identity = await getIdentity(database);
  return {
    userId: crypto.randomUUID(),
    email,
    storeId: storeId ?? identity.storeId,
    deviceId: identity.deviceId,
    storeName: 'Chika Stores',
    writer: true,
  };
}

describe('connecting a store to backup', () => {
  it('does not unlock or back up a store signed out while an authentication check was in flight', async () => {
    await createLocalStore('Chika Stores', database);
    const account = { ...(await response()), restoreReady: true, signedOut: false };
    await database.metadata.put({ key: 'account', value: account });
    const request = vi.fn(async () => {
      await database.metadata.put({ key: 'account', value: { ...account, signedOut: true } });
      return account;
    });
    expect(await runSync({ database, request, force: true })).toBe('local');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await database.metadata.get('account'))?.value).toMatchObject({ signedOut: true });
  });
  it('registers the guest store’s name and ID and preserves every queued record', async () => {
    const store = await createLocalStore('Chika Stores', database);
    await registerStock('Rice', 'mudu', '3', 10000, crypto.randomUUID(), database);
    const queue = await database.outbox.toArray();
    const request = vi.fn(async () => response());
    const onConnected = vi.fn();
    const options = { database, request, onConnected };
    await expect(connectAccount('register', email, password, false, options)).rejects.toThrow(
      'Confirm',
    );
    expect(request).not.toHaveBeenCalled();
    await connectAccount('register', email, password, true, options);
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/auth/register');
    expect(JSON.parse(String(init.body))).toMatchObject({
      storeName: store.name,
      storeId: store.id,
    });
    expect(await database.outbox.toArray()).toEqual(queue);
    expect((await getIdentity(database)).storeId).toBe(store.id);
    expect((await database.metadata.get('account'))?.value).toMatchObject({
      storeId: store.id,
      restoreReady: true,
    });
    expect(JSON.stringify(await database.metadata.toArray())).not.toContain(password);
    expect(onConnected).toHaveBeenCalledOnce();
  });
  it('requires local store creation before registration', async () => {
    const request = vi.fn(async () => response());
    await expect(
      connectAccount('register', email, password, true, { database, request }),
    ).rejects.toThrow('Create your store');
    expect(request).not.toHaveBeenCalled();
  });
  it('restores the authenticated store’s identity and name on a fresh browser', async () => {
    const restored = await response(crypto.randomUUID());
    restored.writer = false;
    await connectAccount('login', email, password, false, {
      database,
      request: async () => restored,
      onConnected: () => {},
    });
    expect((await getIdentity(database)).storeId).toBe(restored.storeId);
    expect((await database.metadata.get('store'))?.value).toMatchObject({
      id: restored.storeId,
      name: restored.storeName,
    });
    expect((await database.metadata.get('account'))?.value).toMatchObject({
      restoreReady: false,
      writer: false,
    });
  });
  it('never adopts another store when this browser has local records', async () => {
    const store = await createLocalStore('Local shop', database);
    await registerStock('Rice', 'mudu', '3', 10000, crypto.randomUUID(), database);
    const request = vi.fn(async () => response(crypto.randomUUID()));
    await expect(
      connectAccount('login', email, password, false, { database, request }),
    ).rejects.toThrow('does not match');
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).expectedStoreId).toBe(store.id);
    expect((await getIdentity(database)).storeId).toBe(store.id);
    expect(await database.outbox.count()).toBe(1);
    expect(await database.metadata.get('account')).toBeUndefined();
  });
  it('keeps a draft entered while sign-in is in flight instead of replacing the ledger', async () => {
    const original = await getIdentity(database);
    const restored = await response(crypto.randomUUID());
    const draft = { customer: 'Mama Chika', rows: [{ name: 'Rice' }] };
    await expect(
      connectAccount('login', email, password, false, {
        database,
        request: async () => {
          await database.metadata.put({ key: 'sale-draft', value: draft });
          return restored;
        },
      }),
    ).rejects.toThrow('Another ledger');
    expect(await getIdentity(database)).toEqual(original);
    expect((await database.metadata.get('sale-draft'))?.value).toEqual(draft);
    expect(await database.metadata.get('account')).toBeUndefined();
  });
  it('rejects a registration response that changes the store ID even without any sales', async () => {
    const store = await createLocalStore('Chika Stores', database);
    await expect(
      connectAccount('register', email, password, true, {
        database,
        request: async () => response(crypto.randomUUID()),
      }),
    ).rejects.toThrow('does not match');
    expect((await getIdentity(database)).storeId).toBe(store.id);
    expect(await database.metadata.get('account')).toBeUndefined();
  });
});
