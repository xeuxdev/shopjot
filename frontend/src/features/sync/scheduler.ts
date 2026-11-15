import Dexie from 'dexie';
import type { OutboxOperation } from '../../domain/index';
import { db } from '../../db/database';
import type { SyncState } from '../../db/sync-state';
import { runSync } from './engine';

export function startSyncScheduler() {
  let running = false,
    stopped = false;
  let rerun = false,
    rerunForced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function registerBackgroundSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return;
    try {
      const registration = (await navigator.serviceWorker.ready) as ServiceWorkerRegistration & {
        sync: { register(tag: string): Promise<void> };
      };
      await registration.sync.register('doris-ledger-sync');
    } catch {
      /* Foreground retries remain authoritative when background sync is unavailable. */
    }
  }
  async function kick(force = false) {
    if (stopped || !navigator.onLine) return;
    if (running) {
      rerun = true;
      rerunForced ||= force;
      return;
    }
    running = true;
    let result: Awaited<ReturnType<typeof runSync>> | undefined;
    try {
      result = await runSync({ force });
    } catch {
      /* Storage failures are surfaced by the ledger; never discard queued operations. */
    } finally {
      running = false;
      const state = (await db.metadata.get('sync'))?.value as SyncState | undefined;
      if (!stopped && rerun) {
        const forced = rerunForced;
        rerun = false;
        rerunForced = false;
        clearTimeout(timer);
        timer = setTimeout(() => void kick(forced), 50);
      } else if (!stopped && result === 'busy') {
        clearTimeout(timer);
        timer = setTimeout(() => void kick(force), 1000);
      } else if (!stopped && state?.status === 'retry') {
        clearTimeout(timer);
        timer = setTimeout(
          () => void kick(),
          Math.max(1000, (state.nextRetryAt ?? Date.now() + 5000) - Date.now()),
        );
        void registerBackgroundSync();
      }
    }
  }
  const changed = () => {
    const tx = Dexie.currentTransaction;
    tx?.on('complete', () => {
      void kick();
      void registerBackgroundSync();
    });
  };
  const updated = (changes: Partial<OutboxOperation>) => {
    if (changes.status === 'pending') changed();
  };
  db.outbox.hook('creating', changed);
  db.outbox.hook('updating', updated);
  const online = () => void kick(true),
    visible = () => {
      if (document.visibilityState === 'visible') void kick(true);
    };
  window.addEventListener('online', online);
  window.addEventListener('doris-sync', online);
  document.addEventListener('visibilitychange', visible);
  const interval = setInterval(() => void kick(), 30_000);
  void kick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    window.removeEventListener('online', online);
    window.removeEventListener('doris-sync', online);
    document.removeEventListener('visibilitychange', visible);
    db.outbox.hook('creating').unsubscribe(changed);
    db.outbox.hook('updating').unsubscribe(updated);
  };
}
