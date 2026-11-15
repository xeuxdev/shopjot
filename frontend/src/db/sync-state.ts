import type { AccountResponse } from '../domain/index';
export interface LocalAccount extends AccountResponse {
  restoreReady: boolean;
  signedOut?: boolean;
}
export interface SyncState {
  status:
    'local' | 'syncing' | 'backed_up' | 'retry' | 'failed' | 'auth_required' | 'device_blocked';
  cursor: string;
  lastBackupAt?: string;
  error?: string;
  nextRetryAt?: number;
  failureCount?: number;
}
export const initialSyncState: SyncState = { status: 'local', cursor: '0' };
