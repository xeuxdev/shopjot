import type { OutboxOperation } from '../domain/index';
import type { DeviceIdentity, LedgerDB } from './database';
import type { LocalAccount } from './sync-state';

export async function assertCanWrite(database: LedgerDB) {
  const account = (await database.metadata.get('account'))?.value as LocalAccount | undefined;
  if (account?.signedOut)
    throw new Error('Sign in to unlock this ledger. Your local records have been kept.');
  if (account && !account.restoreReady)
    throw new Error('Wait for this phone’s restore to finish before recording changes.');
  if (account && !account.writer)
    throw new Error(
      'This phone is in read-only mode. Review the device switch in Settings before recording changes.',
    );
}
export async function enqueue(
  database: LedgerDB,
  identity: DeviceIdentity,
  operationId: string,
  kind: OutboxOperation['kind'],
  payload: unknown,
) {
  const sequence = Number((await database.metadata.get('queue-sequence'))?.value ?? 0) + 1;
  await database.metadata.put({ key: 'queue-sequence', value: sequence });
  await database.outbox.add({
    ...identity,
    operationId,
    kind,
    payload,
    sequence,
    createdAt: new Date().toISOString(),
    status: 'pending',
    attemptCount: 0,
  });
}
