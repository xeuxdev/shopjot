import { useLiveQuery } from 'dexie-react-hooks';
import { db, type DeviceIdentity } from '../db/database';
import { initialSyncState, type LocalAccount, type SyncState } from '../db/sync-state';
export function useLedger() {
  return useLiveQuery(async () => {
    const saved = await db.metadata.get('identity');
    if (!saved) throw new Error('This device has not been initialized.');
    const identity = saved.value as DeviceIdentity;
    return db.transaction('r', db.tables, async () => ({
      identity,
      account: (await db.metadata.get('account'))?.value as LocalAccount | undefined,
      sync: ((await db.metadata.get('sync'))?.value as SyncState | undefined) ?? initialSyncState,
      customers: await db.customers.where('storeId').equals(identity.storeId).sortBy('name'),
      sales: (
        await db.sales.where('storeId').equals(identity.storeId).sortBy('occurredAt')
      ).reverse(),
      items: (await db.saleItems.where('storeId').equals(identity.storeId).toArray()).sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0),
      ),
      payments: await db.payments.where('storeId').equals(identity.storeId).sortBy('receivedAt'),
      products: await db.products.where('storeId').equals(identity.storeId).toArray(),
      units: await db.productUnits.where('storeId').equals(identity.storeId).toArray(),
      movements: await db.stockMovements
        .where('storeId')
        .equals(identity.storeId)
        .sortBy('occurredAt'),
      pending: await db.outbox
        .where('storeId')
        .equals(identity.storeId)
        .and((o) => o.status !== 'acknowledged')
        .count(),
    }));
  });
}
export type Ledger = NonNullable<ReturnType<typeof useLedger>>;
