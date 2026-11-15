import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  CircleHelp,
  Home as HomeIcon,
  Leaf,
  MoreHorizontal,
  Package,
  ReceiptText,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from '../components/ui';
import { useLedger } from '../lib/use-ledger';
import { startSyncScheduler } from '../features/sync/scheduler';
import { BackupSettings, backupLabel } from '../features/sync/backup-settings';
import { SaleEntry } from '../features/sale-entry';
import {
  Home,
  Sales,
  SaleDetail,
  Customers,
  CustomerDetail,
  Stock,
  Settings,
} from '../pages/ledger-pages';

const destinations = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/sales', label: 'Sales', icon: ReceiptText },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/stock', label: 'Stock', icon: Package },
];
export function App() {
  const data = useLedger();
  const location = useLocation();
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(new Date());
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  useEffect(() => startSyncScheduler(), []);
  useEffect(() => {
    const keyboard = () => {
      document.documentElement.dataset.input = 'keyboard';
    };
    const pointer = () => {
      document.documentElement.dataset.input = 'pointer';
    };
    window.addEventListener('keydown', keyboard);
    window.addEventListener('pointerdown', pointer);
    return () => {
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('pointerdown', pointer);
    };
  }, []);
  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <NavLink className="brand" to="/">
          <span className="brand-mark">
            <span>D</span>
            <Leaf size={14} />
          </span>
          <span>
            Doris Foods<small>Store ledger</small>
          </span>
        </NavLink>
        <div className="sidebar-divider" />
        <nav className="desktop-nav" aria-label="Main navigation">
          {destinations.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              <Icon size={20} strokeWidth={1.7} />
              {label}
              {label === 'Sales' && <span className="nav-count">{data?.sales.length ?? 0}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="offline-ready">
            <ShieldCheck size={21} />
            <strong>Made for your everyday.</strong>
            <p>Your ledger works without an internet connection.</p>
          </div>
          <NavLink className="nav-item" to="/settings">
            <SettingsIcon size={19} />
            Settings & data
          </NavLink>
          <div className="owner-profile">
            <span className="owner-avatar">D</span>
            <div>
              <strong>Doris Foods</strong>
              <small>{data?.account ? 'Owner account' : 'Local records'}</small>
            </div>
            <MoreHorizontal size={17} />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <NavLink className="mobile-brand" to="/">
            <span className="brand-mark">
              <span>D</span>
              <Leaf size={12} />
            </span>
            <strong>Doris Foods</strong>
          </NavLink>
          <div className="breadcrumb">
            <BookOpen size={17} />
            <span>My store</span>
            <ChevronRight size={14} />
            <strong>
              {location.pathname === '/'
                ? 'Overview'
                : location.pathname.startsWith('/sales/new')
                  ? 'Record sale'
                  : location.pathname.split('/')[1].replace(/^./, (c) => c.toUpperCase())}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="today-date">
              {new Intl.DateTimeFormat('en-NG', {
                timeZone: 'Africa/Lagos',
                weekday: 'short',
                day: 'numeric',
                month: 'short',
              }).format(now)}
            </span>
            <NavLink to="/settings" className="backup-pill">
              {online ? <span className="status-dot" /> : <WifiOff size={13} />}
              <span>{data ? backupLabel(data, online) : 'Opening ledger…'}</span>
            </NavLink>
            <NavLink to="/settings" className="mobile-settings" aria-label="Settings and data">
              <SettingsIcon size={20} />
            </NavLink>
          </div>
        </header>
        {needRefresh && (
          <div className="update-banner">
            <span>A new version is ready. Finish your sale before updating.</span>
            <Button size="sm" variant="outline" onClick={() => void updateServiceWorker(true)}>
              Update app
            </Button>
          </div>
        )}
        <main id="main" className="main-content" key={location.pathname} tabIndex={-1}>
          {data?.account && (data.account.signedOut || !data.account.restoreReady) ? (
            <>
              <div className="page-heading">
                <div>
                  <h1>{data.account.signedOut ? 'Unlock your ledger' : 'Restoring your ledger'}</h1>
                  <p className="heading-description">
                    {data.account.signedOut
                      ? 'Sign in with the store owner account. All local records have been kept.'
                      : 'Records are downloaded and verified before this phone can create new changes.'}
                  </p>
                </div>
              </div>
              <BackupSettings data={data} notify={setToast} />
            </>
          ) : data ? (
            <Routes>
              <Route path="/" element={<Home data={data} />} />
              <Route path="/sales" element={<Sales data={data} />} />
              <Route path="/sales/new" element={<SaleEntry notify={setToast} />} />
              <Route path="/sales/:id" element={<SaleDetail data={data} notify={setToast} />} />
              <Route path="/customers" element={<Customers data={data} />} />
              <Route path="/customers/:id" element={<CustomerDetail data={data} />} />
              <Route path="/stock" element={<Stock data={data} notify={setToast} />} />
              <Route path="/settings" element={<Settings data={data} notify={setToast} />} />
              <Route
                path="*"
                element={
                  <div className="empty-state">
                    <CircleHelp />
                    <h1>Page not found</h1>
                    <NavLink to="/">Return home</NavLink>
                  </div>
                }
              />
            </Routes>
          ) : (
            <div className="loading-text" role="status">
              Opening your store ledger…
            </div>
          )}
          <footer className="page-footer">
            <span>Doris Foods</span>
            <span>A little order. A better day.</span>
          </footer>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {destinations.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            <span>
              <Icon size={21} strokeWidth={1.8} />
            </span>
            {label}
          </NavLink>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={19} />
          <span>{toast}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Ledger could not open', error.name, info.componentStack);
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <ShieldCheck size={32} />
        <h1>Your ledger could not open</h1>
        <p>
          Enable browser storage and try reloading. Your existing records have not been cleared.
        </p>
        <Button onClick={() => window.location.reload()}>Reload app</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
