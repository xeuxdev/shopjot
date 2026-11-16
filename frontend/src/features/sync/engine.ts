import {
  acknowledgmentSchema,
  accountResponseSchema,
  canonicalJson,
  entityNames,
  manifestSchema,
  pullResponseSchema,
  snapshotJson,
  syncOperationSchema,
  type LedgerSnapshot,
  type OutboxOperation,
  type SyncChange,
  type SyncOperation,
  ZodError,
} from '../../domain/index';
import { db, type LedgerDB, type DeviceIdentity } from '../../db/database';
import { initialSyncState, type LocalAccount, type SyncState } from '../../db/sync-state';
import type { StoreProfile } from '../../db/store';
import { HttpError, requestJson } from './http';
import Dexie from 'dexie';

type Request = typeof requestJson;
class LeaseLost extends Error {}
export const sha256 = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
export async function localSnapshot(database: LedgerDB, storeId: string): Promise<LedgerSnapshot> {
  return {
    customers: await database.customers.where('storeId').equals(storeId).toArray(),
    products: await database.products.where('storeId').equals(storeId).toArray(),
    units: await database.productUnits.where('storeId').equals(storeId).toArray(),
    sales: await database.sales.where('storeId').equals(storeId).toArray(),
    items: await database.saleItems.where('storeId').equals(storeId).toArray(),
    payments: await database.payments.where('storeId').equals(storeId).toArray(),
    movements: await database.stockMovements.where('storeId').equals(storeId).toArray(),
  };
}
export async function toWire(op: OutboxOperation, database: LedgerDB): Promise<SyncOperation> {
  let payload = op.payload;
  if (op.kind === 'sale.create') {
    const p = payload as Extract<SyncOperation, { kind: 'sale.create' }>['payload'];
    const itemIds = new Set(p.items.map((i) => i.id));
    // Version-one saves already required the owner to approve any shortage locally.
    payload = {
      ...p,
      items: p.items.map((item, position) => ({ ...item, position: item.position ?? position })),
      movements:
        p.movements ??
        (await database.stockMovements.where('storeId').equals(op.storeId).toArray()).filter(
          (m) => m.saleItemId && itemIds.has(m.saleItemId),
        ),
      allowNegativeStock: p.allowNegativeStock ?? true,
    };
  }
  return syncOperationSchema.parse({
    version: 1,
    operationId: op.operationId,
    storeId: op.storeId,
    deviceId: op.deviceId,
    kind: op.kind,
    payload,
  });
}
async function putChange(database: LedgerDB, change: SyncChange) {
  switch (change.entity) {
    case 'customers':
      await database.customers.put(change.record);
      break;
    case 'products':
      await database.products.put(change.record);
      break;
    case 'units':
      await database.productUnits.put(change.record);
      break;
    case 'sales':
      await database.sales.put(change.record);
      break;
    case 'items':
      await database.saleItems.put(change.record);
      break;
    case 'payments':
      await database.payments.put(change.record);
      break;
    case 'movements':
      await database.stockMovements.put(change.record);
      break;
  }
}
type SyncOptions = {
  database?: LedgerDB;
  request?: Request;
  force?: boolean;
  retryFailed?: boolean;
};
type SyncResult = 'done' | 'busy' | 'retry' | 'blocked' | 'local';
export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  // Browser locks are released automatically when a tab/worker terminates. A new
  // holder can therefore reclaim an old IndexedDB lease immediately after reload.
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(
      `doris-sync:${(options.database ?? db).name}`,
      { ifAvailable: true },
      (lock) => (lock ? Dexie.ignoreTransaction(() => runWithLease(options, true)) : 'busy'),
    );
  }
  return Dexie.ignoreTransaction(() => runWithLease(options, false));
}
async function runWithLease(options: SyncOptions, exclusive: boolean): Promise<SyncResult> {
  const database = options.database ?? db,
    request = options.request ?? requestJson;
  const owner = crypto.randomUUID();
  const locked = await database.transaction('rw', database.metadata, async () => {
    const lease = (await database.metadata.get('sync-lease'))?.value as
      { owner: string; expires: number } | undefined;
    if (!exclusive && lease && lease.expires > Date.now() && lease.expires <= Date.now() + 90_000)
      return false;
    await database.metadata.put({
      key: 'sync-lease',
      value: { owner, expires: Date.now() + 90_000 },
    });
    return true;
  });
  if (!locked) return 'busy';
  let currentOperation: OutboxOperation | undefined;
  async function lease() {
    await database.transaction('rw', database.metadata, async () => {
      const current = (await database.metadata.get('sync-lease'))?.value as
        { owner: string } | undefined;
      if (current?.owner !== owner) throw new LeaseLost();
      await database.metadata.put({
        key: 'sync-lease',
        value: { owner, expires: Date.now() + 90_000 },
      });
    });
  }
  async function state(patch: Partial<SyncState>) {
    await lease();
    const previous = (await database.metadata.get('sync'))?.value as SyncState | undefined;
    await database.metadata.put({
      key: 'sync',
      value: { ...initialSyncState, ...previous, ...patch },
    });
  }
  try {
    let account = (await database.metadata.get('account'))?.value as LocalAccount | undefined;
    if (!account || account.signedOut) return 'local';
    const previous = (await database.metadata.get('sync'))?.value as SyncState | undefined;
    if (!options.force && previous?.nextRetryAt && previous.nextRetryAt > Date.now())
      return 'retry';
    await state({ status: 'syncing', error: undefined, nextRetryAt: undefined });
    const remoteAccount = accountResponseSchema.parse(await request('/auth/me'));
    if (remoteAccount.storeId !== account.storeId || remoteAccount.deviceId !== account.deviceId)
      throw new HttpError(
        403,
        'STORE_MISMATCH',
        'The signed-in account does not match this local ledger. No records were removed.',
      );
    const refreshed = await database.transaction('rw', database.metadata, async () => {
      const current = (await database.metadata.get('account'))?.value as LocalAccount | undefined;
      if (
        !current ||
        current.signedOut ||
        current.storeId !== remoteAccount.storeId ||
        current.deviceId !== remoteAccount.deviceId
      )
        return false;
      account = { ...current, ...remoteAccount };
      await database.metadata.put({ key: 'account', value: account });
      await database.metadata.put({
        key: 'store',
        value: {
          id: remoteAccount.storeId,
          name: remoteAccount.storeName,
        } satisfies StoreProfile,
      });
      return true;
    });
    if (!refreshed) return 'local';
    if (options.retryFailed)
      await database.outbox
        .where('storeId')
        .equals(account.storeId)
        .and((o) => o.status === 'failed')
        .modify({ status: 'pending', error: undefined });
    for (let uploads = 0; uploads < 100; uploads++) {
      await lease();
      const localAccount = (await database.metadata.get('account'))?.value as LocalAccount;
      if (localAccount.signedOut) return 'local';
      currentOperation = (
        await database.outbox
          .where('storeId')
          .equals(account.storeId)
          .and((o) => o.status !== 'acknowledged')
          .sortBy('sequence')
      )[0];
      if (!currentOperation) break;
      if (currentOperation.status === 'failed') {
        await state({ status: 'failed', error: currentOperation.error });
        return 'blocked';
      }
      let wire: SyncOperation;
      try {
        wire = await toWire(currentOperation, database);
      } catch {
        throw new HttpError(
          422,
          'INVALID_LOCAL_RECORD',
          'A saved change needs review before it can be backed up. Keep a JSON export; the queued record has not been removed.',
        );
      }
      const expectedDigest = await sha256(canonicalJson(wire));
      await database.outbox.update(currentOperation.operationId, {
        attemptCount: currentOperation.attemptCount + 1,
      });
      const ack = acknowledgmentSchema.parse(
        await request('/sync/push', { method: 'POST', body: JSON.stringify(wire) }),
      );
      if (
        ack.operationId !== wire.operationId ||
        ack.storeId !== account.storeId ||
        ack.digest !== expectedDigest
      )
        throw new Error(
          'The server acknowledgment did not match the saved change. It will be retried safely.',
        );
      await lease();
      await database.outbox.update(wire.operationId, {
        status: 'acknowledged',
        acknowledgedAt: ack.acknowledgedAt,
        error: undefined,
      });
      currentOperation = undefined;
    }
    const pending = () =>
      database.outbox
        .where('storeId')
        .equals(account!.storeId)
        .and((o) => o.status !== 'acknowledged')
        .count();
    if (await pending()) {
      await state({ status: 'retry', nextRetryAt: Date.now() + 1000 });
      return 'retry';
    }
    // Read every page, collapse repeated absolute records, then apply in ONE local transaction.
    // No intermediate historical stock balance can be used by a concurrently entered sale.
    let cursor =
      ((await database.metadata.get('sync'))?.value as SyncState | undefined)?.cursor ?? '0';
    const changes = new Map<string, SyncChange>();
    while (true) {
      await lease();
      const page = pullResponseSchema.parse(
        await request(`/sync/pull?cursor=${encodeURIComponent(cursor)}`),
      );
      if (
        BigInt(page.nextCursor) < BigInt(cursor) ||
        (page.hasMore && BigInt(page.nextCursor) === BigInt(cursor))
      )
        throw new Error('The server restore cursor did not advance correctly.');
      for (const change of page.changes) {
        if (change.record.storeId !== account.storeId)
          throw new Error(
            'The restore response included a different store. No records were applied.',
          );
        changes.set(`${change.entity}:${change.record.id}`, change);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const applied = await database.transaction('rw', database.tables, async () => {
      const identity = (await database.metadata.get('identity'))?.value as DeviceIdentity;
      if (identity.storeId !== account!.storeId || (await pending())) return false;
      for (const change of changes.values()) await putChange(database, change);
      const sync = (await database.metadata.get('sync'))?.value as SyncState;
      await database.metadata.put({ key: 'sync', value: { ...sync, cursor } });
      return true;
    });
    if (!applied) {
      await state({ status: 'retry', nextRetryAt: Date.now() + 1000 });
      return 'retry';
    }
    await lease();
    const proof = manifestSchema.parse(await request('/sync/manifest'));
    const local = await database.transaction('r', database.tables, async () => ({
      snapshot: await localSnapshot(database, account!.storeId),
      revision: (await database.metadata.get('queue-sequence'))?.value ?? 0,
    }));
    const localDigest = await sha256(snapshotJson(local.snapshot));
    if (proof.cursor !== cursor) {
      await state({ status: 'retry', nextRetryAt: Date.now() + 1000 });
      return 'retry';
    }
    if (
      localDigest !== proof.digest ||
      entityNames.some((key) => local.snapshot[key].length !== proof.counts[key])
    ) {
      if (await pending()) {
        await state({ status: 'retry', nextRetryAt: Date.now() + 1000 });
        return 'retry';
      }
      throw new HttpError(
        409,
        'VERIFICATION_FAILED',
        'Backup verification found a difference between this phone and the server. Keep a JSON export and retry; no local records have been removed.',
      );
    }
    const complete = await database.transaction(
      'rw',
      [database.metadata, database.outbox],
      async () => {
        const revision = (await database.metadata.get('queue-sequence'))?.value ?? 0;
        if (revision !== local.revision || (await pending())) return false;
        const currentAccount = (await database.metadata.get('account'))?.value as LocalAccount;
        if (currentAccount.signedOut) return false;
        await database.metadata.put({
          key: 'account',
          value: { ...currentAccount, restoreReady: true },
        });
        await database.metadata.put({
          key: 'sync',
          value: {
            status: account!.writer ? 'backed_up' : 'device_blocked',
            cursor,
            lastBackupAt: new Date().toISOString(),
            failureCount: 0,
          } satisfies SyncState,
        });
        return true;
      },
    );
    return complete ? 'done' : 'retry';
  } catch (error) {
    if (error instanceof LeaseLost) return 'busy';
    const message =
      error instanceof ZodError
        ? 'The backup server returned a response that could not be verified. Your local records have been kept and backup will retry.'
        : error instanceof Error
          ? error.message
          : 'Backup could not finish. Your local records have been kept.';
    if (error instanceof HttpError && error.status === 401) {
      await state({ status: 'auth_required', error: message });
      return 'blocked';
    }
    if (error instanceof HttpError && error.code === 'DEVICE_REPLACED') {
      const account = (await database.metadata.get('account'))?.value as LocalAccount;
      await database.metadata.put({ key: 'account', value: { ...account, writer: false } });
      await state({ status: 'device_blocked', error: message });
      return 'blocked';
    }
    if (
      error instanceof HttpError &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      if (currentOperation)
        await database.outbox.update(currentOperation.operationId, {
          status: 'failed',
          error: message,
        });
      await state({ status: 'failed', error: message });
      return 'blocked';
    }
    const previous = (await database.metadata.get('sync'))?.value as SyncState | undefined;
    const failures = (previous?.failureCount ?? 0) + 1;
    await state({
      status: 'retry',
      error: message,
      failureCount: failures,
      nextRetryAt:
        Date.now() +
        Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) * (0.8 + Math.random() * 0.4),
    });
    return 'retry';
  } finally {
    await database.transaction('rw', database.metadata, async () => {
      const lease = (await database.metadata.get('sync-lease'))?.value as
        { owner: string } | undefined;
      if (lease?.owner === owner) await database.metadata.delete('sync-lease');
    });
  }
}
