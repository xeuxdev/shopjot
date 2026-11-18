import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Cloud, ShieldCheck, WifiOff } from 'lucide-react';
import { Button, ErrorMessage } from '../components/ui';
import { ShopjotMark } from '../components/brand';
import { createLocalStore } from '../db/store';
import { userMessage } from '../lib/errors';
import { connectAccount } from './sync/account';

export function StoreSetup({ installAction }: { installAction: ReactNode }) {
  const [mode, setMode] = useState<'create' | 'login'>('create');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') await createLocalStore(name);
      else await connectAccount('login', email, password, false);
    } catch (error) {
      setError(userMessage(error, 'Could not open your store. Please try again.'));
    } finally {
      setBusy(false);
    }
  }
  function changeMode(next: 'create' | 'login') {
    setMode(next);
    setError('');
    setPassword('');
  }
  return (
    <main className={`store-setup${mode === 'login' ? ' store-login' : ''}`} id="main">
      <header className="setup-header">
        <div className="setup-brand brand">
          <ShopjotMark />
          <span>
            Shopjot<small>Your everyday store ledger</small>
          </span>
        </div>
        {installAction}
      </header>
      <div className="setup-layout">
        <section className="setup-intro" aria-labelledby="setup-title">
          <span className="setup-eyebrow">
            <BookOpen size={15} /> A little order. A better day.
          </span>
          <h1 id="setup-title">
            Your store. <br />
            Every sale. <br />
            <span>All together.</span>
          </h1>
          <p>
            Sales, payments, customers, and stock. Keep your shop’s day in one simple ledger, even
            when the internet takes a break.
          </p>
          <div className="setup-benefits">
            <div>
              <WifiOff size={20} />
              <span>
                <strong>Start offline</strong>
                <small>Create your store with just a name.</small>
              </span>
            </div>
            <div>
              <Cloud size={20} />
              <span>
                <strong>Back up when you’re ready</strong>
                <small>Register or sign in to keep a server copy.</small>
              </span>
            </div>
            <div>
              <ShieldCheck size={20} />
              <span>
                <strong>A ledger of your own</strong>
                <small>Your store gets a unique, permanent ID.</small>
              </span>
            </div>
          </div>
        </section>
        <section className="panel setup-card" aria-labelledby="setup-form-title">
          <div className="setup-form-icon">
            <BookOpen size={24} />
          </div>
          <h2 id="setup-form-title">
            {mode === 'create' ? 'Let’s open your store' : 'Welcome back'}
          </h2>
          <p className="heading-description">
            {mode === 'create'
              ? 'No account needed to get started. What should we call your store?'
              : 'Sign in to download your store’s backed-up records. You’ll need an internet connection.'}
          </p>
          <form onSubmit={submit} className="setup-form">
            {mode === 'create' ? (
              <div className="field">
                <label htmlFor="setup-name">Store name</label>
                <input
                  id="setup-name"
                  name="storeName"
                  autoComplete="organization"
                  placeholder="e.g. Mama Chika’s shop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={160}
                  required
                  aria-describedby="setup-name-hint"
                />
                <p className="field-hint" id="setup-name-hint">
                  Your store name can be the same as another shop. Your unique ID keeps your records
                  separate.
                </p>
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="setup-email">Owner email</label>
                  <input
                    id="setup-email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="setup-password">Password</label>
                  <input
                    id="setup-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    maxLength={128}
                    required
                  />
                </div>
              </>
            )}
            <ErrorMessage message={error} />
            <Button className="full-width" disabled={busy}>
              {busy ? (
                mode === 'create' ? (
                  'Opening your store…'
                ) : (
                  'Signing in…'
                )
              ) : mode === 'create' ? (
                <>
                  Create store & get started <ArrowRight size={17} />
                </>
              ) : (
                'Sign in and restore'
              )}
            </Button>
          </form>
          <div className="setup-switch">
            <span>
              {mode === 'create' ? 'Already have a backed-up store?' : 'Opening a new store?'}
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => changeMode(mode === 'create' ? 'login' : 'create')}
            >
              {mode === 'create' ? 'Sign in to your store' : 'Create a store without an account'}
            </Button>
          </div>
          <p className="quiet-note">
            {mode === 'create'
              ? 'Records stay on this browser until you connect an account for backup. Keep exports as an extra copy.'
              : 'Your store downloads before you can record new changes. Every phone signed in to this store can record sales.'}
          </p>
        </section>
      </div>
      <footer className="setup-footer">Made for the way you run your store.</footer>
    </main>
  );
}
