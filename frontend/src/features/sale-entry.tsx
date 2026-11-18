import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Check,
  Package,
  ShieldCheck,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';
import {
  ZodError,
  lineTotal,
  money,
  nairaInput,
  normalize,
  parseNaira,
  sumKobo,
  decimalToMilli,
} from '../domain/index';
import { db } from '../db/database';
import { saveSale } from '../db/ledger';
import { useLedger } from '../lib/use-ledger';
import { Button, ErrorMessage } from '../components/ui';

interface Row {
  id: string;
  name: string;
  quantity: string;
  label: string;
  price: string;
  unitId: string | null;
}
interface Draft {
  id: string;
  operationId: string;
  customer: string;
  customerId?: string;
  rows: Row[];
  payment: 'full' | 'partial' | 'unpaid';
  amount: string;
}
const emptyRow = (): Row => ({
  id: crypto.randomUUID(),
  name: '',
  quantity: '1',
  label: '',
  price: '',
  unitId: null,
});
const fresh = (): Draft => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  customer: '',
  rows: [emptyRow()],
  payment: 'full',
  amount: '',
});
function subtotal(row: Row) {
  try {
    return lineTotal(row.quantity, parseNaira(row.price));
  } catch {
    return null;
  }
}

export function SaleEntry({ notify }: { notify: (message: string) => void }) {
  const data = useLedger();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(fresh);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [customerFocus, setCustomerFocus] = useState(false);
  const [itemFocus, setItemFocus] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [allowNegative, setAllowNegative] = useState(false);
  const busy = useRef(false);
  const completed = useRef(false);
  useEffect(() => {
    let active = true;
    void db.metadata
      .get('sale-draft')
      .then(async (saved) => {
        if (!active) return;
        if (saved) {
          const value = saved.value as Draft;
          if (!(await db.sales.get(value.id)) && active) setDraft(value);
        }
        if (active) setLoaded(true);
      })
      .catch(() => {
        if (active) {
          setError('Your draft could not be loaded. Please reload before recording a sale.');
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded || completed.current) return;
    const timer = setTimeout(() => {
      if (!completed.current)
        void db.metadata
          .put({ key: 'sale-draft', value: draft })
          .catch(() =>
            setError('Your draft could not be saved. Keep this page open until you save the sale.'),
          );
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, loaded]);
  const update = (value: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...value }));
    setError('');
  };
  const rowUpdate = (id: string, value: Partial<Row>) =>
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...value } : r)) }));
  let total = 0;
  let totalValid = false;
  let totalError = '';
  try {
    const subtotals = draft.rows.map(subtotal);
    if (subtotals.every((value) => value !== null)) {
      total = sumKobo(subtotals);
      totalValid = true;
    }
  } catch {
    totalError = 'The sale total is too large. Reduce the quantities or prices.';
  }
  let received = 0;
  let receivedValid = false;
  try {
    received =
      draft.payment === 'full' ? total : draft.payment === 'partial' ? parseNaira(draft.amount) : 0;
    receivedValid = draft.payment !== 'full' || totalValid;
  } catch {
    /* Validated on save. */
  }
  const similar = draft.customer.trim()
    ? (data?.customers
        .filter(
          (c) =>
            normalize(c.name).includes(normalize(draft.customer)) ||
            normalize(draft.customer).includes(normalize(c.name)),
        )
        .slice(0, 5) ?? [])
    : [];
  const stockWarnings: string[] = [];
  if (data) {
    const quantities = new Map<string, bigint>();
    for (const row of draft.rows)
      if (row.unitId) {
        try {
          quantities.set(
            row.unitId,
            (quantities.get(row.unitId) ?? 0n) + decimalToMilli(row.quantity),
          );
        } catch {
          /* Field validation handles incomplete inputs. */
        }
      }
    for (const [unitId, quantity] of quantities) {
      const unit = data.units.find((u) => u.id === unitId);
      if (unit && decimalToMilli(unit.quantityOnHand) < quantity)
        stockWarnings.push(
          `${data.products.find((p) => p.id === unit.productId)?.name}: only ${unit.quantityOnHand} ${unit.label} in stock.`,
        );
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !loaded || !data) return;
    setError('');
    if (!totalValid) {
      setError(totalError || 'Enter a valid quantity and price for every item before saving.');
      return;
    }
    if (!draft.customerId && similar.length && !confirmNew) {
      setError(
        'A similar customer already exists. Choose their name below or confirm this is a different customer.',
      );
      setCustomerFocus(true);
      return;
    }
    if (stockWarnings.length && !allowNegative) {
      setError('Confirm that you want to save despite the stock shortage.');
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      const sale = await saveSale({
        id: draft.id,
        operationId: draft.operationId,
        customerName: draft.customer,
        customerId: draft.customerId,
        occurredAt: new Date().toISOString(),
        items: draft.rows.map((r) => ({
          id: r.id,
          name: r.name,
          quantity: r.quantity,
          quantityLabel: r.label,
          unitPriceKobo: parseNaira(r.price),
          productUnitId: r.unitId,
        })),
        initialPaymentKobo: draft.payment === 'partial' ? parseNaira(draft.amount) : received,
        allowNegativeStock: allowNegative,
      });
      completed.current = true;
      await db.metadata.delete('sale-draft').catch(() => undefined);
      notify('Sale saved on this phone');
      navigate(`/sales/${sale.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof ZodError
          ? err.issues
              .map((issue) => {
                const path = issue.path;
                return `${path[0] === 'items' ? `Item ${Number(path[1]) + 1}: ` : path[0] === 'customerName' ? 'Customer: ' : ''}${issue.message}`;
              })
              .join(' ')
          : err instanceof Error
            ? err.message
            : 'Could not save the sale. Please try again.',
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  if (!loaded || !data)
    return (
      <p className="loading-text" role="status">
        Opening your sale book…{error}
      </p>
    );
  if (data.account && !data.account.writer)
    return (
      <section className="panel form-section">
        <h1>This phone is read-only</h1>
        <p className="heading-description">
          Open Settings to review which phone can create new records.
        </p>
        <Link className="back-link" to="/settings">
          Settings & data
        </Link>
      </section>
    );
  return (
    <div className="sale-page">
      <Link to="/" className="back-link">
        <ArrowLeft size={17} />
        Back to your shop
      </Link>
      <div className="page-heading">
        <div>
          <p className="subtle">A name, the goods, and what was paid.</p>
          <h1>Record a sale</h1>
        </div>
        <span className="draft-label">Draft saved on this phone</span>
      </div>
      <form onSubmit={submit} noValidate className="sale-layout">
        <div className="sale-fields">
          <section className="panel form-section">
            <div className="form-section-heading">
              <span className="step">1</span>
              <h2>Who’s buying?</h2>
            </div>
            <div className="field suggestion-anchor">
              <label htmlFor="customer-name">
                Customer name <span className="required">*</span>
              </label>
              <input
                id="customer-name"
                autoComplete="off"
                placeholder="e.g. Mama Chika"
                required
                maxLength={160}
                value={draft.customer}
                onFocus={() => setCustomerFocus(true)}
                onBlur={() => setTimeout(() => setCustomerFocus(false), 150)}
                onChange={(e) => {
                  update({ customer: e.target.value, customerId: undefined });
                  setConfirmNew(false);
                }}
              />
              {customerFocus && draft.customer.trim() && similar.length > 0 && (
                <div className="suggestions" aria-label="Existing customers">
                  {similar.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        update({ customer: c.name, customerId: c.id });
                        setCustomerFocus(false);
                      }}
                    >
                      <span className="avatar small">{c.name[0]}</span>
                      <span>
                        {c.name}
                        <small>Existing customer · {c.id.slice(0, 6)}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="field-hint">Choose an existing name, or type a new customer’s name.</p>
            {!draft.customerId && similar.length > 0 && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmNew}
                  onChange={(e) => setConfirmNew(e.target.checked)}
                />
                This is a different customer. Create a new record.
              </label>
            )}
          </section>
          <section className="panel form-section">
            <div className="form-section-heading">
              <span className="step">2</span>
              <h2>What did they buy?</h2>
              <span className="subtle">
                {draft.rows.length} {draft.rows.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <div className="item-rows">
              {draft.rows.map((row, index) => {
                const rowTotal = subtotal(row);
                const matches = data.units
                  .filter((u) =>
                    data.products
                      .find((p) => p.id === u.productId)
                      ?.name.toLocaleLowerCase()
                      .includes(row.name.toLocaleLowerCase()),
                  )
                  .slice(0, 5);
                return (
                  <div className="sale-item" key={row.id}>
                    <div className="item-top">
                      <span>Item {index + 1}</span>
                      {draft.rows.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove item ${index + 1}`}
                          onClick={() =>
                            update({ rows: draft.rows.filter((r) => r.id !== row.id) })
                          }
                        >
                          <Trash2 size={17} />
                        </Button>
                      )}
                    </div>
                    <div className="field suggestion-anchor">
                      <label htmlFor={`item-${row.id}`}>
                        Item name <span className="required">*</span>
                      </label>
                      <input
                        id={`item-${row.id}`}
                        placeholder="Type any goods, e.g. Rice"
                        value={row.name}
                        maxLength={160}
                        autoComplete="off"
                        onFocus={() => setItemFocus(row.id)}
                        onBlur={() => setTimeout(() => setItemFocus(null), 150)}
                        onChange={(e) => rowUpdate(row.id, { name: e.target.value, unitId: null })}
                      />
                      {itemFocus === row.id &&
                        row.name.trim() &&
                        !row.unitId &&
                        matches.length > 0 && (
                          <div className="suggestions" aria-label="Stock suggestions">
                            {matches.map((u) => {
                              const product = data.products.find((p) => p.id === u.productId)!;
                              return (
                                <button
                                  type="button"
                                  key={u.id}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    rowUpdate(row.id, {
                                      name: product.name,
                                      label: u.label,
                                      price: nairaInput(u.suggestedUnitPriceKobo),
                                      unitId: u.id,
                                    });
                                    setItemFocus(null);
                                  }}
                                >
                                  <Package size={18} />
                                  <span>
                                    {product.name}
                                    <small>
                                      {u.quantityOnHand} {u.label} in stock ·{' '}
                                      {money(u.suggestedUnitPriceKobo)} / {u.label}
                                    </small>
                                  </span>
                                  <Plus size={16} />
                                </button>
                              );
                            })}
                          </div>
                        )}
                    </div>
                    <div className="item-numbers">
                      <div className="field">
                        <label htmlFor={`qty-${row.id}`}>Quantity</label>
                        <input
                          id={`qty-${row.id}`}
                          inputMode="decimal"
                          value={row.quantity}
                          onChange={(e) => rowUpdate(row.id, { quantity: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`unit-${row.id}`}>Unit / label</label>
                        <input
                          id={`unit-${row.id}`}
                          placeholder="e.g. mudu"
                          maxLength={160}
                          value={row.label}
                          onChange={(e) =>
                            rowUpdate(row.id, { label: e.target.value, unitId: null })
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`price-${row.id}`}>Price per unit (₦)</label>
                        <input
                          id={`price-${row.id}`}
                          inputMode="decimal"
                          placeholder="0"
                          value={row.price}
                          onChange={(e) => rowUpdate(row.id, { price: e.target.value })}
                        />
                      </div>
                    </div>
                    <div
                      className="unit-chips"
                      aria-label={`Unit suggestions for item ${index + 1}`}
                    >
                      {['mudu', 'paint', 'kg', 'bag', 'piece'].map((label) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => rowUpdate(row.id, { label, unitId: null })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="item-bottom">
                      <span className={row.unitId ? 'stock-linked' : 'subtle'}>
                        {row.unitId ? (
                          <>
                            <Check size={13} />
                            Linked to stock
                          </>
                        ) : (
                          'Not tracked in inventory'
                        )}
                      </span>
                      <strong>{rowTotal === null ? '—' : money(rowTotal)}</strong>
                    </div>
                  </div>
                );
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              className="add-item"
              disabled={draft.rows.length >= 100}
              onClick={() => update({ rows: [...draft.rows, emptyRow()] })}
            >
              <Plus size={17} />
              Add another item
            </Button>
          </section>
        </div>
        <aside className="sale-summary">
          <section className="panel form-section">
            <div className="form-section-heading">
              <span className="step">3</span>
              <h2>Payment</h2>
            </div>
            <div className="checkout-total">
              <span>Sale total</span>
              <strong>{totalValid ? money(total) : '—'}</strong>
            </div>
            <div className="payment-options" role="radiogroup" aria-label="Payment type">
              {(
                [
                  ['full', 'Paid in full', 'The full amount was received'],
                  ['partial', 'Part payment', 'Some paid, some still owed'],
                  ['unpaid', 'Credit / unpaid', 'No money received yet'],
                ] as const
              ).map(([value, title, text]) => (
                <label
                  key={value}
                  className={draft.payment === value ? 'payment-option selected' : 'payment-option'}
                >
                  <input
                    type="radio"
                    name="payment"
                    value={value}
                    checked={draft.payment === value}
                    onChange={() => update({ payment: value })}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{text}</small>
                  </span>
                </label>
              ))}
            </div>
            {draft.payment === 'partial' && (
              <div className="field partial-field">
                <label htmlFor="amount-received">Amount received (₦)</label>
                <input
                  id="amount-received"
                  inputMode="decimal"
                  placeholder="0"
                  value={draft.amount}
                  onChange={(e) => update({ amount: e.target.value })}
                />
              </div>
            )}
            <div className="summary-row">
              <span>Amount received</span>
              <strong>{receivedValid ? money(received) : '—'}</strong>
            </div>
            <div className="summary-row owed">
              <span>Amount still owed</span>
              <strong>
                {totalValid && receivedValid && received <= total ? money(total - received) : '—'}
              </strong>
            </div>
            {stockWarnings.length > 0 && (
              <div className="stock-warning">
                <AlertTriangle size={18} />
                <div>
                  {stockWarnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={allowNegative}
                      onChange={(e) => setAllowNegative(e.target.checked)}
                    />
                    Save anyway and record a negative stock balance.
                  </label>
                </div>
              </div>
            )}
            <ErrorMessage message={error} />
            <Button type="submit" className="save-sale" disabled={saving}>
              <Check size={18} />
              {saving ? 'Saving sale…' : 'Save sale'}
            </Button>
            <p className="local-save-note">
              <ShieldCheck size={14} />
              Saves on this phone, even offline
            </p>
          </section>
          <p className="quiet-note">
            Prices can change for this sale. Your saved records will keep these exact prices.
          </p>
        </aside>
      </form>
    </div>
  );
}
