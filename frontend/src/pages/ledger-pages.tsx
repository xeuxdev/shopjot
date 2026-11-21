import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/database';
import { hasDraftContent, type Draft } from '../features/sale-draft';
import { CustomerPayment } from '../features/customer-payment';
import { SaleActions } from '../features/sale-actions';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  Download,
  Leaf,
  Package,
  Plus,
  ReceiptText,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import {
  dashboard,
  money,
  outstandingFor,
  parseNaira,
  paymentStatus,
  sumKobo,
  z,
  type Sale,
} from '../domain/index';
import type { Ledger } from '../lib/use-ledger';
import { formatSalesDay, salesDateRange, salesPeriods, salesView } from '../lib/sales-view';
import { adjustStock, recordPayment, registerStock } from '../db/ledger';
import { exportData, type ExportKind } from '../lib/export';
import { userMessage } from '../lib/errors';
import { BackupSettings } from '../features/sync/backup-settings';
import { Button, Empty, ErrorMessage, Modal, SearchField, SectionTitle } from '../components/ui';

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const shortDate = (date: string) => dateFormat.format(new Date(date));
const saleTime = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  hour: 'numeric',
  minute: '2-digit',
});
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
export function Status({ sale, data }: { sale: Sale; data: Ledger }) {
  if (sale.status === 'voided') return <span className="status-badge voided">Voided</span>;
  const status = paymentStatus(sale, data.payments);
  return (
    <span className={`status-badge ${status}`}>
      {status === 'paid' && <Check size={12} />}
      {{ paid: 'Paid', partial: 'Part payment', unpaid: 'Unpaid' }[status]}
    </span>
  );
}
export function SaleRow({
  sale,
  data,
  showTime,
}: {
  sale: Sale;
  data: Ledger;
  showTime?: boolean;
}) {
  const customer = data.customers.find((c) => c.id === sale.customerId);
  const items = data.items.filter((i) => i.saleId === sale.id);
  return (
    <Link to={`/sales/${sale.id}`} className="ledger-row">
      <span className="avatar">{initials(customer?.name ?? '?')}</span>
      <div className="row-main">
        <strong>{customer?.name ?? 'Customer'}</strong>
        <span>{items.map((i) => `${i.quantity} ${i.quantityLabel} ${i.name}`).join(', ')}</span>
        {showTime && (
          <time dateTime={sale.occurredAt}>{saleTime.format(new Date(sale.occurredAt))}</time>
        )}
      </div>
      <div className="row-amount">
        <strong>{money(sale.totalKobo)}</strong>
        <Status sale={sale} data={data} />
      </div>
      <ChevronRight className="row-chevron" size={17} />
    </Link>
  );
}
export function Home({ data }: { data: Ledger }) {
  const navigate = useNavigate();
  const stats = dashboard(data.sales, data.payments);
  const draft = useLiveQuery(async () => {
    const saved = (await db.metadata.get('sale-draft'))?.value as Draft | undefined;
    return saved && hasDraftContent(saved) && !(await db.sales.get(saved.id)) ? saved : undefined;
  });
  const reversedPayments = new Set(
    data.payments.filter((p) => p.reversalOf).map((p) => p.reversalOf),
  );
  const owedCustomers = data.customers
    .map((c) => ({
      ...c,
      owed: sumKobo(
        data.sales
          .filter((s) => s.customerId === c.id)
          .map((s) => outstandingFor(s, data.payments)),
      ),
    }))
    .filter((c) => c.owed > 0)
    .sort((a, b) => b.owed - a.owed);
  const activity = [
    ...data.sales
      .filter((s) => s.status === 'active')
      .map((s) => ({
        type: 'sale' as const,
        date: s.occurredAt,
        sale: s,
        amount: s.totalKobo,
        id: s.id,
      })),
    ...data.payments
      .filter((p) => {
        const s = data.sales.find((s) => s.id === p.saleId);
        return (
          s?.status === 'active' &&
          !p.reversalOf &&
          !reversedPayments.has(p.id) &&
          p.receivedAt !== s.occurredAt
        );
      })
      .map((p) => ({
        type: 'payment' as const,
        date: p.receivedAt,
        sale: data.sales.find((s) => s.id === p.saleId)!,
        amount: p.amountKobo,
        id: p.id,
      })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);
  return (
    <>
      <div className="page-heading home-heading">
        <div>
          <p className="subtle greeting">{data.store?.name}</p>
          <h1>Your shop, at a glance.</h1>
          <p className="heading-description">Every sale recorded. Every naira accounted for.</p>
        </div>
        <Button onClick={() => navigate('/sales/new')}>
          <Plus size={19} />
          Record sale
        </Button>
      </div>
      {draft && (
        <div className="draft-banner">
          <div>
            <strong>Finish your {draft.correction ? 'correction' : 'sale'}</strong>
            <p>{draft.customer || 'An unfinished sale'} is saved on this phone.</p>
          </div>
          <Link className="button button-outline" to="/sales/new">
            Resume draft
          </Link>
        </div>
      )}
      <div className="stats-grid">
        <section className="sales-stat">
          <div className="stat-label">
            <span>Today’s sales</span>
            <span className="stat-icon">
              <ReceiptText size={20} />
            </span>
          </div>
          <strong className="stat-value">{money(stats.salesKobo)}</strong>
          <div className="sales-stat-bottom">
            <span>
              {stats.saleCount} {stats.saleCount === 1 ? 'sale' : 'sales'} recorded today
            </span>
            <span className="stat-leaf">
              <Leaf size={48} strokeWidth={1} />
            </span>
          </div>
        </section>
        <section className="panel stat">
          <div className="stat-label">
            <span>Collected today</span>
            <span className="stat-icon mint">
              <Wallet size={19} />
            </span>
          </div>
          <strong className="stat-value">{money(stats.collectedKobo)}</strong>
          <p>Payments received, including older debts</p>
        </section>
        <section className="panel stat">
          <div className="stat-label">
            <span>Total owed</span>
            <span className="stat-icon peach">
              <Users size={19} />
            </span>
          </div>
          <strong className="stat-value">{money(stats.owedKobo)}</strong>
          <p>
            {owedCustomers.length
              ? `${owedCustomers.length} ${owedCustomers.length === 1 ? 'customer has' : 'customers have'} an outstanding balance`
              : 'All customer balances are clear'}
          </p>
        </section>
      </div>
      <div className="home-columns">
        <section className="panel activity-panel">
          <SectionTitle action="All sales" onClick={() => navigate('/sales')}>
            Recent activity
          </SectionTitle>
          {activity.length ? (
            <div>
              {activity.map((a) =>
                a.type === 'sale' ? (
                  <SaleRow key={a.id} sale={a.sale} data={data} />
                ) : (
                  <Link to={`/sales/${a.sale.id}`} className="ledger-row" key={a.id}>
                    <span className="activity-icon">
                      <ArrowDownLeft size={20} />
                    </span>
                    <div className="row-main">
                      <strong>
                        {data.customers.find((c) => c.id === a.sale.customerId)?.name}
                      </strong>
                      <span>Repayment · {shortDate(a.date)}</span>
                    </div>
                    <div className="row-amount">
                      <strong>{money(a.amount)}</strong>
                      <span className="payment-text">Payment received</span>
                    </div>
                    <ChevronRight className="row-chevron" size={17} />
                  </Link>
                ),
              )}
            </div>
          ) : (
            <Empty
              title="Your next sale starts here"
              action={
                <Button variant="outline" onClick={() => navigate('/sales/new')}>
                  <Plus size={16} />
                  Record your first sale
                </Button>
              }
            >
              Keep the day’s goods, payments, and customer balances together.
            </Empty>
          )}
          <div className="panel-footer">
            <ShieldCheck size={15} />
            <span>Ready for a full day, with or without internet.</span>
          </div>
        </section>
        <aside className="home-aside">
          <section className="panel owed-panel">
            <SectionTitle action="View" onClick={() => navigate('/customers')}>
              Customers owing
            </SectionTitle>
            {owedCustomers.length ? (
              owedCustomers.slice(0, 4).map((c) => (
                <Link className="debt-row" to={`/customers/${c.id}`} key={c.id}>
                  <span className="avatar small">{initials(c.name)}</span>
                  <strong>{c.name}</strong>
                  <span>{money(c.owed)}</span>
                </Link>
              ))
            ) : (
              <div className="clear-balances">
                <span>
                  <CircleCheck size={25} strokeWidth={1.5} />
                </span>
                <strong>A clean slate</strong>
                <p>Customers with unpaid balances will appear here.</p>
              </div>
            )}
          </section>
          <section className="shop-note">
            <div className="note-icon">
              <Leaf size={19} />
            </div>
            <h3>A good day starts with good records.</h3>
            <p>Record each sale as it happens. Even small purchases help the numbers add up.</p>
            <Link to="/sales/new">
              Open your sale book
              <ArrowUpRight size={15} />
            </Link>
          </section>
        </aside>
      </div>
      <div className="local-banner">
        <span className="local-banner-icon">
          <ShieldCheck size={21} />
        </span>
        <div>
          <strong>Your records stay close.</strong>
          <p>
            {data.account
              ? data.pending
                ? `${data.pending} changes are saved locally and waiting for backup. Open Settings to check progress.`
                : data.sync.status === 'backed_up' && data.sync.lastBackupAt
                  ? 'Every ledger record was checked against your server backup. Keep an export as an extra copy.'
                  : 'Open Settings to check your server backup.'
              : 'Connect your owner account in Settings to back up this phone’s records automatically.'}
          </p>
        </div>
        <Link to="/settings" className="text-link">
          Manage data
          <ChevronRight size={16} />
        </Link>
      </div>
    </>
  );
}
export function Sales({ data }: { data: Ledger }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const search = params.get('search') ?? '';
  const status = ['paid', 'partial', 'unpaid', 'voided'].includes(params.get('status') ?? '')
    ? params.get('status')!
    : 'all';
  const period = salesPeriods.find(([key]) => key === params.get('period'))?.[0] ?? 'all';
  const validDate = (key: string) => {
    const value = params.get(key) ?? '';
    return z.iso.date().safeParse(value).success ? value : '';
  };
  const { from, to } =
    period === 'custom' ? { from: validDate('from'), to: validDate('to') } : salesDateRange(period);
  const invalidRange = Boolean(from && to && from > to);
  const view = salesView(data, { search, status, from, to });
  const filtered = Boolean(search || status !== 'all' || period !== 'all');
  const rangeLabel =
    from && to
      ? from === to
        ? formatSalesDay(from)
        : `${formatSalesDay(from)} – ${formatSalesDay(to)}`
      : from
        ? `From ${formatSalesDay(from)}`
        : to
          ? `Up to ${formatSalesDay(to)}`
          : 'All dates';
  function updateFilter(key: string, value: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value && !((key === 'period' || key === 'status') && value === 'all'))
          next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }
  const clearFilters = () => setParams({}, { replace: true });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="subtle">Your store’s sale book</p>
          <h1>Sales</h1>
          <p className="heading-description">Find a sale and see how each day adds up.</p>
        </div>
        <Button onClick={() => navigate('/sales/new')}>
          <Plus size={18} />
          Record sale
        </Button>
      </div>
      <section className="panel sales-book" aria-label="Sale book">
        <div className="sales-date-controls">
          <div className="sales-filter-heading">
            <span>
              <CalendarDays size={17} aria-hidden="true" /> Sale dates
            </span>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
          <div className="sales-periods" role="group" aria-label="Filter by sale dates">
            {salesPeriods.map(([key, title]) => (
              <button
                key={key}
                type="button"
                aria-pressed={period === key}
                onClick={() => updateFilter('period', key)}
              >
                {title}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="sales-date-range">
              <div>
                <label htmlFor="sales-from">From date</label>
                <input
                  id="sales-from"
                  type="date"
                  value={from}
                  onChange={(e) => updateFilter('from', e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="sales-to">To date</label>
                <input
                  id="sales-to"
                  type="date"
                  min={from || undefined}
                  value={to}
                  aria-invalid={invalidRange || undefined}
                  aria-describedby={invalidRange ? 'sales-range-error' : undefined}
                  onChange={(e) => updateFilter('to', e.target.value)}
                />
              </div>
              <p
                className={invalidRange ? 'field-error' : 'field-hint'}
                id="sales-range-error"
                role={invalidRange ? 'alert' : undefined}
              >
                {invalidRange
                  ? 'Choose a to date on or after the from date.'
                  : 'Both dates are included. Use the same date to see one day.'}
              </p>
            </div>
          )}
        </div>
        <div className="list-toolbar sales-search">
          <SearchField
            value={search}
            onChange={(value) => updateFilter('search', value)}
            placeholder="Search customer or goods…"
          />
        </div>
        <div className="filter-tabs" role="group" aria-label="Filter payment status">
          {[
            ['all', 'All sales'],
            ['paid', 'Paid'],
            ['partial', 'Part payment'],
            ['unpaid', 'Unpaid'],
            ['voided', 'Voided'],
          ].map(([key, title]) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === status}
              className={status === key ? 'active' : ''}
              onClick={() => updateFilter('status', key)}
            >
              {title}
            </button>
          ))}
        </div>
        {invalidRange ? (
          <Empty title="Check your date range">
            The from date must come before or on the to date.
          </Empty>
        ) : (
          <>
            <div className="sales-totals" role="status" aria-live="polite" aria-atomic="true">
              <div className="sales-total-main">
                <h2>{filtered ? 'Total sales matching filters' : 'Total sales'}</h2>
                <strong>{money(view.totalKobo)}</strong>
                <p>
                  {rangeLabel} · {view.count} {view.count === 1 ? 'record' : 'records'}
                </p>
              </div>
              <p className="sales-total-note">
                Includes unpaid sales. Voided sales are excluded from totals.
              </p>
            </div>
            {view.count ? (
              view.groups.map((group) => (
                <section
                  className="sales-day"
                  key={group.day}
                  aria-label={`Sales for ${formatSalesDay(group.day)}`}
                >
                  <div className="sales-day-heading">
                    <div>
                      <h2>
                        <time dateTime={group.day}>{formatSalesDay(group.day)}</time>
                      </h2>
                      <p>
                        {group.sales.length} {group.sales.length === 1 ? 'record' : 'records'}
                      </p>
                    </div>
                    <div className="sales-day-total">
                      <span>Daily total</span>
                      <strong>{money(group.totalKobo)}</strong>
                    </div>
                  </div>
                  {group.sales.map((sale) => (
                    <SaleRow key={sale.id} sale={sale} data={data} showTime />
                  ))}
                </section>
              ))
            ) : (
              <Empty
                title={data.sales.length ? 'No matching sales' : 'Your sale book is ready'}
                action={
                  filtered ? (
                    <Button variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : undefined
                }
              >
                {data.sales.length
                  ? 'Try different dates, a customer name, or a payment status.'
                  : 'Record a sale to start keeping track of your day.'}
              </Empty>
            )}
          </>
        )}
      </section>
    </>
  );
}
export function SaleDetail({ data, notify }: { data: Ledger; notify: (message: string) => void }) {
  const { id } = useParams();
  const sale = data.sales.find((s) => s.id === id);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  if (!sale)
    return <Empty title="Sale not found">Open the sale book to choose a saved sale.</Empty>;
  const customer = data.customers.find((c) => c.id === sale.customerId);
  const items = data.items.filter((i) => i.saleId === sale.id);
  const payments = data.payments.filter((p) => p.saleId === sale.id);
  const owed = outstandingFor(sale, payments);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current || !sale) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await recordPayment(sale.id, parseNaira(amount), operationId.current);
      setOpen(false);
      setAmount('');
      operationId.current = crypto.randomUUID();
      notify('Payment saved on this phone');
    } catch (err) {
      setError(userMessage(err, 'Could not save payment.'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <>
      <Link to="/sales" className="back-link">
        <ArrowLeft size={17} />
        All sales
      </Link>
      <div className="page-heading">
        <div>
          <p className="subtle">{shortDate(sale.occurredAt)}</p>
          <h1>{customer?.name}</h1>
          <p className="heading-description">Sale #{sale.id.slice(0, 8)}</p>
        </div>
        <Status sale={sale} data={data} />
      </div>
      <div className="detail-layout">
        <section className="panel receipt">
          <SectionTitle>Goods bought</SectionTitle>
          {items.map((i) => (
            <div className="receipt-item" key={i.id}>
              <div>
                <strong>{i.name}</strong>
                <p>
                  {i.quantity} {i.quantityLabel} × {money(i.unitPriceKobo)}
                </p>
                <small>{i.productUnitId ? 'Linked to stock' : 'Not tracked in inventory'}</small>
              </div>
              <strong>{money(i.lineTotalKobo)}</strong>
            </div>
          ))}
          <div className="receipt-total">
            <span>Sale total</span>
            <strong>{money(sale.totalKobo)}</strong>
          </div>
          <div className="receipt-note">
            <ShieldCheck size={16} />
            Saved on this phone
          </div>
        </section>
        <section className="panel payment-history">
          <SectionTitle>Payments</SectionTitle>
          {payments.length ? (
            payments.map((p) => (
              <div className="payment-event" key={p.id}>
                <span className="activity-icon">
                  <ArrowDownLeft size={18} />
                </span>
                <div>
                  <strong>{money(p.amountKobo)}</strong>
                  <small>{shortDate(p.receivedAt)}</small>
                  <small>
                    {p.reversalOf
                      ? 'Reversal of recorded payment'
                      : data.payments.some((entry) => entry.reversalOf === p.id)
                        ? 'Reversed payment'
                        : p.receivedAt === sale.occurredAt
                          ? 'Received at sale'
                          : 'Later repayment'}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <p className="muted-block">No payment received yet.</p>
          )}
          <div className="balance-due">
            <span>Amount still owed</span>
            <strong>{money(owed)}</strong>
          </div>
          {owed > 0 && (
            <Button
              className="full-width"
              onClick={() => {
                setError('');
                setOpen(true);
              }}
            >
              <Plus size={17} />
              Record payment
            </Button>
          )}
          <Link className="customer-link" to={`/customers/${customer?.id}`}>
            View customer ledger
            <ChevronRight size={15} />
          </Link>
        </section>
      </div>
      <SaleActions sale={sale} data={data} notify={notify} />
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Record payment"
        description={`For ${customer?.name} · sale #${sale.id.slice(0, 8)}`}
      >
        <form onSubmit={submit}>
          <div className="modal-balance">
            <span>Amount still owed</span>
            <strong>{money(owed)}</strong>
          </div>
          <div className="field">
            <label htmlFor="repayment-amount">Amount received (₦)</label>
            <input
              id="repayment-amount"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <p className="field-hint">This payment applies only to this sale.</p>
          <ErrorMessage message={error} />
          <Button className="full-width modal-submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save payment'}
          </Button>
        </form>
      </Modal>
    </>
  );
}
export function Customers({ data }: { data: Ledger }) {
  const [search, setSearch] = useState('');
  const [owingOnly, setOwingOnly] = useState(false);
  const customers = data.customers
    .map((c) => ({
      ...c,
      owed: sumKobo(
        data.sales
          .filter((s) => s.customerId === c.id)
          .map((s) => outstandingFor(s, data.payments)),
      ),
    }))
    .filter(
      (c) =>
        c.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
        (!owingOnly || c.owed > 0),
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="subtle">The people behind your sales</p>
          <h1>Customers</h1>
          <p className="heading-description">Purchases, payments, and balances in one place.</p>
        </div>
      </div>
      <section className="panel">
        <div className="list-toolbar">
          <SearchField value={search} onChange={setSearch} placeholder="Search customer name…" />
        </div>
        <div className="filter-tabs">
          <button className={!owingOnly ? 'active' : ''} onClick={() => setOwingOnly(false)}>
            All customers
          </button>
          <button className={owingOnly ? 'active' : ''} onClick={() => setOwingOnly(true)}>
            Customers owing
          </button>
        </div>
        {customers.length ? (
          customers.map((c) => (
            <Link to={`/customers/${c.id}`} className="ledger-row" key={c.id}>
              <span className="avatar">{initials(c.name)}</span>
              <div className="row-main">
                <strong>{c.name}</strong>
                <span>
                  {data.sales.filter((s) => s.customerId === c.id).length} sales ·{' '}
                  {c.phone ?? `#${c.id.slice(0, 6)}`}
                </span>
              </div>
              <div className="row-amount">
                <strong>{money(c.owed)}</strong>
                <span className={c.owed ? 'owing-text' : 'subtle'}>
                  {c.owed ? 'Still owed' : 'All paid'}
                </span>
              </div>
              <ChevronRight size={17} />
            </Link>
          ))
        ) : (
          <Empty
            title={data.customers.length ? 'No matching customers' : 'Get to know your ledger'}
          >
            {data.customers.length
              ? 'Try another name or view all customers.'
              : 'Customers appear automatically when you record their first sale.'}
          </Empty>
        )}
      </section>
    </>
  );
}
export function CustomerDetail({
  data,
  notify,
}: {
  data: Ledger;
  notify: (message: string) => void;
}) {
  const { id } = useParams();
  const customer = data.customers.find((c) => c.id === id);
  if (!customer)
    return <Empty title="Customer not found">Choose a customer from your ledger.</Empty>;
  const sales = data.sales.filter((s) => s.customerId === id);
  const owed = sumKobo(sales.map((s) => outstandingFor(s, data.payments)));
  return (
    <>
      <Link to="/customers" className="back-link">
        <ArrowLeft size={17} />
        All customers
      </Link>
      <div className="page-heading">
        <div>
          <p className="subtle">Customer ledger</p>
          <h1>{customer.name}</h1>
          <p className="heading-description">
            {sales.length} sales since{' '}
            {new Intl.DateTimeFormat('en-NG', {
              timeZone: 'Africa/Lagos',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }).format(new Date(customer.createdAt))}
          </p>
        </div>
      </div>
      <div className="customer-summary panel">
        <div>
          <span>Amount still owed</span>
          <strong>{money(owed)}</strong>
        </div>
        <CustomerPayment customerId={customer.id} data={data} notify={notify} />
      </div>
      <section className="panel">
        <SectionTitle>Purchases</SectionTitle>
        {sales.map((s) => (
          <SaleRow key={s.id} sale={s} data={data} />
        ))}
      </section>
      <section className="panel customer-payments">
        <SectionTitle>Payment history</SectionTitle>
        {data.payments
          .filter((p) => sales.some((s) => s.id === p.saleId))
          .reverse()
          .map((p) => (
            <Link className="payment-event" to={`/sales/${p.saleId}`} key={p.id}>
              <span className="activity-icon">
                <ArrowDownLeft size={18} />
              </span>
              <div>
                <strong>{money(p.amountKobo)}</strong>
                <small>
                  {shortDate(p.receivedAt)} · sale #{p.saleId.slice(0, 8)}
                  {p.reversalOf
                    ? ' · Payment reversal'
                    : data.payments.some((entry) => entry.reversalOf === p.id)
                      ? ' · Reversed'
                      : ''}
                </small>
              </div>
              <ChevronRight size={16} />
            </Link>
          ))}
      </section>
    </>
  );
}
export function Stock({ data, notify }: { data: Ledger; notify: (message: string) => void }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', label: '', quantity: '', price: '' });
  const [count, setCount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const op = useRef(crypto.randomUUID());
  const units = data.units.filter((u) =>
    `${data.products.find((p) => p.id === u.productId)?.name} ${u.label}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const selected = data.units.find((u) => u.id === adjusting);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      if (adjusting) {
        await adjustStock(adjusting, count, op.current);
        setAdjusting(null);
        notify('Stock count updated on this phone');
      } else {
        await registerStock(
          form.name,
          form.label,
          form.quantity,
          parseNaira(form.price),
          op.current,
        );
        setOpen(false);
        setForm({ name: '', label: '', quantity: '', price: '' });
        notify('Stock item saved on this phone');
      }
      op.current = crypto.randomUUID();
    } catch (err) {
      setError(userMessage(err, 'Could not save stock.'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="subtle">Know what’s on your shelves</p>
          <h1>Stock</h1>
          <p className="heading-description">
            Simple counts and selling prices, in your own units.
          </p>
        </div>
        <Button
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          <Plus size={18} />
          Add stock item
        </Button>
      </div>
      <section className="panel">
        <div className="list-toolbar">
          <SearchField value={search} onChange={setSearch} placeholder="Search stock…" />
        </div>
        {units.length ? (
          units.map((u) => (
            <div className="ledger-row stock-row" key={u.id}>
              <span className="stock-product-icon">
                <Package size={21} />
              </span>
              <div className="row-main">
                <strong>{data.products.find((p) => p.id === u.productId)?.name}</strong>
                <span>
                  {money(u.suggestedUnitPriceKobo)} / {u.label}
                </span>
              </div>
              <div className="row-amount">
                <strong className={u.quantityOnHand.startsWith('-') ? 'owing-text' : ''}>
                  {u.quantityOnHand} <small>{u.label}</small>
                </strong>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAdjusting(u.id);
                    setCount(u.quantityOnHand);
                    setError('');
                  }}
                >
                  Adjust count
                </Button>
              </div>
            </div>
          ))
        ) : (
          <Empty
            title={data.units.length ? 'No matching stock' : 'Start with what’s on your shelves'}
            action={
              !data.units.length && (
                <Button variant="outline" onClick={() => setOpen(true)}>
                  <Plus size={16} />
                  Add your first item
                </Button>
              )
            }
          >
            {data.units.length
              ? 'Try another product name or quantity label.'
              : 'Stock is optional. You can always record a sale with freely typed goods.'}
          </Empty>
        )}
      </section>
      <p className="quiet-note">
        Each unit is counted separately. A paint of rice never automatically converts to mudu.
      </p>
      <Modal
        open={open || !!adjusting}
        onOpenChange={(value) => {
          if (!value) {
            setOpen(false);
            setAdjusting(null);
          }
        }}
        title={adjusting ? 'Adjust stock count' : 'Add stock item'}
        description={
          adjusting
            ? 'Enter the current physical count. This change will be recorded in stock history.'
            : 'Use any product name and quantity label.'
        }
      >
        <form onSubmit={submit} noValidate>
          {adjusting && selected ? (
            <>
              <p className="modal-product-name">
                {data.products.find((p) => p.id === selected.productId)?.name} / {selected.label}
              </p>
              <p className="field-hint">
                Current count: {selected.quantityOnHand} {selected.label}
              </p>
              <div className="field">
                <label htmlFor="stock-count">New count ({selected.label})</label>
                <input
                  id="stock-count"
                  inputMode="decimal"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </div>
              <div className="movement-history">
                <h3>Recent stock movements</h3>
                {data.movements
                  .filter((m) => m.productUnitId === selected.id)
                  .reverse()
                  .slice(0, 5)
                  .map((m) => (
                    <div key={m.id}>
                      <span>{m.reason.replaceAll('_', ' ')}</span>
                      <strong>
                        {m.quantityDelta} {selected.label}
                      </strong>
                    </div>
                  ))}
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="stock-name">Product name</label>
                <input
                  id="stock-name"
                  placeholder="e.g. Rice"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="stock-label">Quantity label</label>
                <input
                  id="stock-label"
                  placeholder="e.g. mudu, bag, small paint"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                />
              </div>
              <div className="two-fields">
                <div className="field">
                  <label htmlFor="stock-quantity">Current stock</label>
                  <input
                    id="stock-quantity"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.quantity}
                    onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="stock-price">Price per unit (₦)</label>
                  <input
                    id="stock-price"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.price}
                    onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  />
                </div>
              </div>
            </>
          )}
          <ErrorMessage message={error} />
          <Button className="full-width modal-submit" disabled={saving}>
            {saving ? 'Saving…' : adjusting ? 'Confirm new count' : 'Save stock item'}
          </Button>
        </form>
      </Modal>
    </>
  );
}
export function Settings({ data, notify }: { data: Ledger; notify: (message: string) => void }) {
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  async function download(kind: ExportKind) {
    setWorking(true);
    setError('');
    try {
      await exportData(kind);
      notify('Your export is ready');
    } catch (error) {
      setError(userMessage(error, 'Could not export your data. Please try again.'));
    } finally {
      setWorking(false);
    }
  }
  async function persist() {
    try {
      if (!navigator.storage?.persist) {
        notify(
          'This browser does not support a persistent storage request. Keep an exported copy.',
        );
        return;
      }
      const granted = await navigator.storage.persist();
      notify(
        granted
          ? 'Persistent storage is enabled for this phone'
          : 'This browser did not grant persistent storage. Keep an exported copy.',
      );
    } catch {
      setError('Could not request persistent storage.');
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="subtle">Keep your store’s records safe</p>
          <h1>Settings & data</h1>
        </div>
      </div>
      <div className="settings-layout">
        <BackupSettings data={data} notify={notify} />
        <section className="panel form-section">
          <h2>Saved on this phone</h2>
          <div className="backup-summary">
            <ShieldCheck size={24} />
            <div>
              <strong>
                {data.pending} pending {data.pending === 1 ? 'operation' : 'operations'}
              </strong>
              <p>
                {data.account
                  ? 'New records save here first and remain queued until the server acknowledges them.'
                  : 'Connect your owner account to enable automatic server backup.'}
              </p>
            </div>
          </div>
          <p className="settings-warning">
            Losing this phone, uninstalling the app, or clearing browser storage can erase these
            records. Download an export and keep a copy somewhere safe.
          </p>
          <Button variant="outline" onClick={persist}>
            <ShieldCheck size={17} />
            Keep storage on this device
          </Button>
        </section>
        <section className="panel form-section">
          <h2>Export your records</h2>
          <p className="heading-description">
            PDF and CSV show amounts in naira and dates in Africa/Lagos time. JSON keeps the
            complete ledger in its original format; an import screen is not available yet.
          </p>
          <div className="export-actions">
            <Button variant="outline" disabled={working} onClick={() => download('pdf')}>
              <Download size={17} />
              Export transactions PDF
            </Button>
            <Button variant="outline" disabled={working} onClick={() => download('json')}>
              <Download size={17} />
              Download full JSON copy
            </Button>
            <Button variant="outline" disabled={working} onClick={() => download('sales')}>
              <Download size={17} />
              Export sales CSV
            </Button>
            <Button variant="outline" disabled={working} onClick={() => download('customers')}>
              <Download size={17} />
              Export customers CSV
            </Button>
          </div>
          <ErrorMessage message={error} />
        </section>
        <section className="panel form-section">
          <h2>Your store</h2>
          <dl className="about-list">
            <div>
              <dt>Store</dt>
              <dd className="store-name">{data.store?.name}</dd>
            </div>
            <div>
              <dt>Store ID</dt>
              <dd className="store-id">{data.identity.storeId}</dd>
            </div>
            <div>
              <dt>Backup account</dt>
              <dd>{data.account ? data.account.email : 'Not connected · local use'}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>Nigerian naira (₦)</dd>
            </div>
            <div>
              <dt>Timezone</dt>
              <dd>Africa/Lagos</dd>
            </div>
            <div>
              <dt>Current stage</dt>
              <dd>Local-first ledger with verified backup</dd>
            </div>
          </dl>
          <p className="quiet-note">
            Backup runs on reconnect and while this app is available. Browser background sync is
            used where supported. Audited correction and voiding flows remain a follow-up.
          </p>
        </section>
      </div>
    </>
  );
}
