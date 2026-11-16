import { accountResponseSchema } from '../../domain/index';
import { db, getIdentity, type LedgerDB, type DeviceIdentity } from '../../db/database';
import { hasLocalRecords, type StoreProfile } from '../../db/store';
import { initialSyncState, type LocalAccount } from '../../db/sync-state';
import { requestJson } from './http';

export const requestSync = () => window.dispatchEvent(new Event('doris-sync'));
export async function connectAccount(
  mode: 'register' | 'login',
  email: string,
  password: string,
  adoptLocalRecords: boolean,
  options: { database?: LedgerDB; request?: typeof requestJson; onConnected?: () => void } = {},
) {
  const database = options.database ?? db;
  const identity = await getIdentity(database);
  const saved = await database.transaction('r', database.tables, async () => ({
    hasRecords: await hasLocalRecords(database),
    account: (await database.metadata.get('account'))?.value as LocalAccount | undefined,
    store: (await database.metadata.get('store'))?.value as StoreProfile | undefined,
  }));
  if (mode === 'register' && (!saved.store || saved.store.id !== identity.storeId))
    throw new Error('Create your store before setting up backup.');
  if (mode === 'register' && saved.account)
    throw new Error('This store already has an account. Sign in to resume backup.');
  if (mode === 'register' && saved.hasRecords && !adoptLocalRecords)
    throw new Error('Confirm that these local records belong to the store you are registering.');
  const response = accountResponseSchema.parse(
    await (options.request ?? requestJson)(`/auth/${mode}`, {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        deviceId: identity.deviceId,
        ...(mode === 'register'
          ? { storeId: identity.storeId, storeName: saved.store!.name }
          : saved.hasRecords || saved.account
            ? { expectedStoreId: identity.storeId }
            : {}),
      }),
    }),
  );
  if (
    response.deviceId !== identity.deviceId ||
    ((mode === 'register' || saved.hasRecords || saved.account) &&
      response.storeId !== identity.storeId)
  )
    throw new Error('The signed-in store does not match this ledger. No records were changed.');
  await database.transaction('rw', database.tables, async () => {
    const currentIdentity = (await database.metadata.get('identity'))?.value as DeviceIdentity;
    if (
      currentIdentity.storeId !== identity.storeId ||
      currentIdentity.deviceId !== identity.deviceId
    )
      throw new Error('The active store changed while connecting. Please sign in again.');
    if (response.storeId !== identity.storeId && (await hasLocalRecords(database)))
      throw new Error('Another ledger already exists on this phone. No records were changed.');
    if (response.storeId !== identity.storeId) await database.metadata.delete('sale-draft');
    await database.metadata.put({
      key: 'identity',
      value: { ...identity, storeId: response.storeId },
    });
    await database.metadata.put({
      key: 'store',
      value: {
        id: response.storeId,
        name: response.storeName,
      } satisfies StoreProfile,
    });
    await database.metadata.put({
      key: 'account',
      value: {
        ...response,
        restoreReady:
          mode === 'register' ||
          (saved.account?.storeId === response.storeId && saved.account.restoreReady),
        signedOut: false,
      } satisfies LocalAccount,
    });
    if (mode === 'register' || saved.account?.storeId !== response.storeId)
      await database.metadata.put({ key: 'sync', value: initialSyncState });
  });
  (options.onConnected ?? requestSync)();
}
export async function signOut() {
  // Server logout must succeed; an offline click does not silently leave a live server session.
  await requestJson('/auth/logout', { method: 'POST', body: '{}' });
  const account = (await db.metadata.get('account'))?.value as LocalAccount;
  await db.metadata.put({ key: 'account', value: { ...account, signedOut: true } });
}
export async function claimDevice() {
  const identity = await getIdentity();
  const account = accountResponseSchema.parse(
    await requestJson('/devices/claim', {
      method: 'POST',
      body: JSON.stringify({ deviceId: identity.deviceId, confirmPreviousDeviceBackedUp: true }),
    }),
  );
  const saved = (await db.metadata.get('account'))?.value as LocalAccount;
  await db.metadata.put({ key: 'account', value: { ...saved, ...account } });
  requestSync();
}
