import { nameSchema } from '../domain/index';
import { db, getIdentity, type LedgerDB } from './database';
import type { LocalAccount } from './sync-state';

export interface StoreProfile {
  id: string;
  name: string;
}

// Call inside a transaction covering all tables when deciding whether a restore
// may adopt a different store ID. Drafts and unacknowledged records count too.
export async function hasLocalRecords(database: LedgerDB): Promise<boolean> {
  for (const table of database.tables) {
    if (table.name !== 'metadata' && (await table.count())) return true;
  }
  const draft = (await database.metadata.get('sale-draft'))?.value as
    | {
        customer?: string;
        customerId?: string;
        rows?: {
          name?: string;
          label?: string;
          price?: string;
          quantity?: string;
          unitId?: string | null;
        }[];
        payment?: string;
        amount?: string;
      }
    | undefined;
  return !!(
    draft?.customer?.trim() ||
    draft?.customerId ||
    draft?.amount?.trim() ||
    (draft?.payment && draft.payment !== 'full') ||
    draft?.rows?.some(
      (row) =>
        row.name?.trim() ||
        row.label?.trim() ||
        row.price?.trim() ||
        row.unitId ||
        (row.quantity && row.quantity !== '1'),
    )
  );
}

export async function createLocalStore(name: string, database = db): Promise<StoreProfile> {
  const validated = nameSchema.parse(name);
  return database.transaction('rw', database.metadata, async () => {
    const identity = await getIdentity(database);
    const saved = (await database.metadata.get('store'))?.value as StoreProfile | undefined;
    if (saved) {
      if (saved.id === identity.storeId && saved.name === validated) return saved;
      throw new Error('A store is already set up on this browser. Its records have been kept.');
    }
    const store = { id: identity.storeId, name: validated };
    await database.metadata.add({ key: 'store', value: store });
    return store;
  });
}

export async function initializeStore(database = db) {
  await getIdentity(database);
  // Existing installations predate the named-store setup. Adopt their identity
  // and records in place; never rename the IndexedDB database or regenerate IDs.
  await database.transaction('rw', database.tables, async () => {
    if (await database.metadata.get('store')) return;
    const account = (await database.metadata.get('account'))?.value as LocalAccount | undefined;
    if (!account && !(await hasLocalRecords(database))) return;
    await createLocalStore(account?.storeName ?? 'Doris Foods', database);
  });
}
