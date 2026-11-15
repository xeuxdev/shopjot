import { accountResponseSchema } from '../../domain/index';
import { db, getIdentity } from '../../db/database';
import { initialSyncState, type LocalAccount } from '../../db/sync-state';
import { requestJson } from './http';

export const requestSync = () => window.dispatchEvent(new Event('doris-sync'));
export async function connectAccount(
  mode: 'register' | 'login',
  email: string,
  password: string,
  adoptLocalRecords: boolean,
) {
  const identity = await getIdentity();
  const counts = await db.transaction('r', db.tables, async () => {
    const draft = (await db.metadata.get('sale-draft'))?.value as
      { customer?: string; rows?: { name?: string }[] } | undefined;
    const unfinished = !!(draft?.customer?.trim() || draft?.rows?.some((row) => row.name?.trim()));
    return {
      count:
        (await db.sales.count()) +
        (await db.products.count()) +
        (await db.customers.count()) +
        Number(unfinished),
      account: (await db.metadata.get('account'))?.value as LocalAccount | undefined,
    };
  });
  if (mode === 'register' && counts.count && !adoptLocalRecords)
    throw new Error('Confirm that these local records belong to the store you are registering.');
  const response = accountResponseSchema.parse(
    await requestJson(`/auth/${mode}`, {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        deviceId: identity.deviceId,
        ...(mode === 'register'
          ? { storeId: identity.storeId, storeName: 'Doris Foods' }
          : counts.count || counts.account
            ? { expectedStoreId: identity.storeId }
            : {}),
      }),
    }),
  );
  await db.transaction('rw', db.tables, async () => {
    if (
      response.storeId !== identity.storeId &&
      ((await db.sales.count()) ||
        (await db.products.count()) ||
        (await db.customers.count()) ||
        (await db.outbox.count()))
    )
      throw new Error('Another ledger already exists on this phone. No records were changed.');
    if (response.storeId !== identity.storeId) await db.metadata.delete('sale-draft');
    await db.metadata.put({ key: 'identity', value: { ...identity, storeId: response.storeId } });
    await db.metadata.put({
      key: 'account',
      value: {
        ...response,
        restoreReady:
          mode === 'register' ||
          (counts.account?.storeId === response.storeId && counts.account.restoreReady),
        signedOut: false,
      } satisfies LocalAccount,
    });
    if (mode === 'register' || counts.account?.storeId !== response.storeId)
      await db.metadata.put({ key: 'sync', value: initialSyncState });
  });
  requestSync();
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
