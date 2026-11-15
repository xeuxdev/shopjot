import { useState, type FormEvent } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Button, ErrorMessage } from '../../components/ui';
import type { Ledger } from '../../lib/use-ledger';
import { userMessage } from '../../lib/errors';
import { claimDevice, connectAccount, signOut } from './account';
import { runSync } from './engine';

export function backupLabel(data: Ledger, online = true) {
  if (!data.account) return 'Saved on this phone';
  if (data.account.signedOut) return 'Sign in to unlock';
  if (!online) return data.pending ? 'Offline · saved locally' : 'Offline';
  if (data.sync.status === 'syncing') return 'Syncing';
  if (data.sync.status === 'failed') return 'Backup needs attention';
  if (data.sync.status === 'auth_required') return 'Sign in to back up';
  if (!data.account.writer) return 'Read-only phone';
  if (data.pending || data.sync.status === 'retry') return 'Saved on this phone';
  return data.sync.lastBackupAt ? 'Backed up' : 'Saved on this phone';
}
export function BackupSettings({
  data,
  notify,
}: {
  data: Ledger;
  notify: (message: string) => void;
}) {
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState('');
  const [adopt, setAdopt] = useState(false),
    [takeover, setTakeover] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const account = data.account;
  const needsLogin = !account || account.signedOut || data.sync.status === 'auth_required';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await connectAccount(account ? 'login' : mode, email, password, adopt);
      setPassword('');
      notify('Connected. Your ledger is being checked and backed up.');
    } catch (error) {
      setError(userMessage(error, 'Could not connect. Your local records have been kept.'));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError('');
    try {
      const result = await runSync({ force: true, retryFailed: true });
      if (result === 'done') notify('Every ledger record has been verified with the server');
    } catch (error) {
      setError(userMessage(error, 'Backup could not finish.'));
    } finally {
      setBusy(false);
    }
  }
  async function switchPhone() {
    setBusy(true);
    setError('');
    try {
      await claimDevice();
      notify('This is now the primary editing phone');
    } catch (error) {
      setError(userMessage(error, 'Could not switch devices.'));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    try {
      await signOut();
      setPassword('');
      notify('Signed out. Local records have been kept.');
    } catch (error) {
      setError(userMessage(error, 'Connect to the internet to sign out.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-section backup-settings">
      <h2>Backup & account</h2>
      <div className="backup-summary">
        <ShieldCheck size={24} />
        <div>
          <strong>{backupLabel(data, navigator.onLine)}</strong>
          <p>
            {data.pending} {data.pending === 1 ? 'change waiting' : 'changes waiting'} for server
            acknowledgment.
          </p>
          {data.sync.lastBackupAt && (
            <p>
              Last verified backup:{' '}
              {new Intl.DateTimeFormat('en-NG', {
                timeZone: 'Africa/Lagos',
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(data.sync.lastBackupAt))}
            </p>
          )}
        </div>
      </div>
      {data.sync.error && <ErrorMessage message={data.sync.error} />}
      {needsLogin ? (
        <form onSubmit={submit} className="account-form">
          {!account && (
            <div className="filter-tabs">
              <button
                type="button"
                className={mode === 'register' ? 'active' : ''}
                onClick={() => setMode('register')}
              >
                Create account
              </button>
              <button
                type="button"
                className={mode === 'login' ? 'active' : ''}
                onClick={() => setMode('login')}
              >
                Sign in / restore
              </button>
            </div>
          )}
          <p className="field-hint">
            {account
              ? 'Sign in again to resume backup. Your offline records are still on this phone.'
              : mode === 'register'
                ? 'Connect this store to your private server backup. Local saves will keep working offline.'
                : 'Sign in to restore your backed-up store. A new phone starts in read-only mode until you explicitly switch devices.'}
          </p>
          <div className="field">
            <label htmlFor="account-email">Owner email</label>
            <input
              id="account-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="account-password">Password</label>
            <input
              id="account-password"
              type="password"
              autoComplete={!account && mode === 'register' ? 'new-password' : 'current-password'}
              minLength={12}
              maxLength={128}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {!account && mode === 'register' && (
            <label className="checkbox-label">
              <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
              The records on this phone belong to the store I’m registering.
            </label>
          )}
          <p className="quiet-note">
            This phone stays available offline after sign-in. Use your phone’s screen lock; local
            browser records are not encrypted by this app.
          </p>
          <Button className="full-width modal-submit" disabled={busy}>
            {busy
              ? 'Connecting…'
              : account || mode === 'login'
                ? 'Sign in and restore'
                : 'Create account & back up'}
          </Button>
        </form>
      ) : (
        <>
          <p className="account-email">{account.email}</p>
          <Button
            variant="outline"
            disabled={busy || data.sync.status === 'syncing'}
            onClick={() => void retry()}
          >
            <RefreshCw size={16} />
            Retry backup / verify records
          </Button>
          {!account.writer && (
            <div className="device-switch">
              <h3>Use this phone for new records</h3>
              <p className="quiet-note">
                Only one phone can upload new changes. First back up the previous phone. Unbacked
                changes left there cannot be recovered from the server.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={takeover}
                  onChange={(e) => setTakeover(e.target.checked)}
                />
                I have backed up the previous phone, or understand that its unbacked changes still
                need to be recovered separately.
              </label>
              <Button
                disabled={!takeover || busy || !account.restoreReady}
                onClick={() => void switchPhone()}
              >
                Make this the primary phone
              </Button>
            </div>
          )}
          <p className="quiet-note">
            Signing out keeps all local records and pending changes. You need internet to sign back
            in.
          </p>
          <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
            Sign out and lock this ledger
          </Button>
        </>
      )}
      <ErrorMessage message={error} />
    </section>
  );
}
