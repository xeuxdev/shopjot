import { useEffect, useRef, useState, type FormEvent, type FocusEvent } from 'react';
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
  nameSchema,
  quantitySchema,
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
import { Button, ErrorMessage, Modal } from '../components/ui';
import { emptyRow, fresh, hasDraftContent, type Draft, type Row } from './sale-draft';

function subtotal(row: Row) {
  try {
    return lineTotal(row.quantity, parseNaira(row.price));
  } catch {
    return null;
  }
}

function validateDraft(value: Draft) {
  const errors: Record<string, string> = {};
  const name = nameSchema.safeParse(value.customer);
  if (!name.success) errors['customer-name'] = 'Customer: Enter a name of 160 characters or fewer.';
  for (const row of value.rows) {
    if (!nameSchema.safeParse(row.name).success) errors[`item-${row.id}`] = 'Enter an item name.';
    if (!quantitySchema.safeParse(row.quantity).success)
      errors[`qty-${row.id}`] = 'Enter a quantity greater than zero, with up to 3 decimal places.';
    if (!nameSchema.safeParse(row.label).success)
      errors[`unit-${row.id}`] = 'Enter a unit, such as kg or piece.';
    try {
      parseNaira(row.price);
    } catch {
      errors[`price-${row.id}`] = 'Enter a valid price with up to 2 decimal places.';
    }
  }
  let saleTotal: number | undefined;
  try {
    saleTotal = sumKobo(value.rows.map((row) => lineTotal(row.quantity, parseNaira(row.price))));
  } catch {
    /* Incomplete goods are validated above. */
  }
  if (value.payment === 'partial') {
    try {
      const amount = parseNaira(value.amount);
      if (!amount)
        errors['amount-received'] = 'Enter an amount greater than zero, or choose Credit / unpaid.';
      else if (saleTotal !== undefined && amount > saleTotal)
        errors['amount-received'] = 'Amount received cannot exceed the sale total.';
    } catch {
      errors['amount-received'] = 'Enter a valid amount with up to 2 decimal places.';
    }
  }
  if (value.correction && !value.correction.reason.trim())
    errors['correction-reason'] = 'Enter a reason for the correction.';
  return errors;
}

export function SaleEntry({ notify }: { notify: (message: string) => void }) {
  const data = useLedger();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(fresh);
  const [loaded, setLoaded] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'saving' | 'saved' | 'failed'>('saving');
  const [retryDraft, setRetryDraft] = useState(0);
  const [restored, setRestored] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const summaryRef = useRef<HTMLElement>(null);
  const saveVersion = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const focusNextCustomer = useRef(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [customerFocus, setCustomerFocus] = useState(false);
  const [itemFocus, setItemFocus] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [allowNegative, setAllowNegative] = useState(false);
  const busy = useRef(false);
  const completed = useRef(false);
  useEffect(() => {
    if (!saving && focusNextCustomer.current) {
      focusNextCustomer.current = false;
      document.getElementById('customer-name')?.focus();
    }
  }, [saving]);
  useEffect(() => {
    let active = true;
    void db.metadata
      .get('sale-draft')
      .then(async (saved) => {
        if (!active) return;
        if (saved) {
          const value = saved.value as Draft;
          if (!(await db.sales.get(value.id)) && active) {
            setDraft(value);
            setRestored(hasDraftContent(value));
          }
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
    const version = ++saveVersion.current;
    let active = true;
    setDraftStatus('saving');
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await db.transaction('rw', [db.metadata, db.sales], async () => {
          if (!completed.current && !(await db.sales.get(draft.id)))
            await db.metadata.put({ key: 'sale-draft', value: draft });
        });
        if (active && version === saveVersion.current) setDraftStatus('saved');
      } catch {
        if (active && version === saveVersion.current) setDraftStatus('failed');
      }
    });
    return () => {
      active = false;
    };
  }, [draft, loaded, retryDraft]);
  const validation = validateDraft(draft);
  const fieldErrors = Object.fromEntries(Object.entries(validation).filter(([id]) => touched[id]));
  const fieldProps = (id: string) => ({
    'aria-invalid': !!fieldErrors[id],
    'aria-describedby': fieldErrors[id] ? `${id}-error` : undefined,
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Submit validates all fields. Avoid moving its button between pointer
      // down and pointer up when an inline error first appears on blur.
      if (event.relatedTarget instanceof HTMLButtonElement && event.relatedTarget.type === 'submit')
        return;
      setTouched((previous) => ({ ...previous, [id]: true }));
    },
  });
  const fieldError = (id: string) =>
    fieldErrors[id] ? (
      <p className="field-error" id={`${id}-error`}>
        {fieldErrors[id]}
      </p>
    ) : null;
  const update = (value: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...value }));
    setError('');
    setDraftStatus('saving');
  };
  const rowUpdate = (id: string, value: Partial<Row>) => {
    setError('');
    setDraftStatus('saving');
    setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...value } : r)) }));
  };
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
  const recentGoods = (() => {
    if (!data) return [];
    const saleDates = new Map(
      data.sales.filter((s) => s.status === 'active').map((s) => [s.id, s.occurredAt]),
    );
    const seen = new Set<string>();
    return [...data.items]
      .filter((item) => saleDates.has(item.saleId))
      .sort((a, b) => saleDates.get(b.saleId)!.localeCompare(saleDates.get(a.saleId)!))
      .filter((item) => {
        const key = `${normalize(item.name)}|${normalize(item.quantityLabel)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
  })();
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
      const restoredQuantity = draft.correction
        ? data.items
            .filter(
              (item) => item.saleId === draft.correction!.saleId && item.productUnitId === unitId,
            )
            .reduce((sum, item) => sum + decimalToMilli(item.quantity), 0n)
        : 0n;
      if (unit && decimalToMilli(unit.quantityOnHand) + restoredQuantity < quantity)
        stockWarnings.push(
          `${data.products.find((p) => p.id === unit.productId)?.name}: only ${unit.quantityOnHand} ${unit.label} in stock.`,
        );
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saveAnother =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('data-save-another') === 'true';
    if (busy.current || !loaded || !data) return;
    setError('');
    const errors = validation;
    if (Object.keys(errors).length) {
      setTouched(Object.fromEntries(Object.keys(errors).map((id) => [id, true])));
      const first = Object.keys(errors)[0];
      setError(
        first.startsWith('price-') || first.startsWith('qty-')
          ? 'Enter a valid quantity and price for every item before saving.'
          : errors[first],
      );
      document.getElementById(first)?.focus();
      return;
    }
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
        occurredAt: draft.correction?.occurredAt ?? new Date().toISOString(),
        correction: draft.correction,
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
      ++saveVersion.current;
      await saveQueue.current;
      await db
        .transaction('rw', db.metadata, async () => {
          const saved = (await db.metadata.get('sale-draft'))?.value as Draft | undefined;
          if (saved?.id === draft.id) await db.metadata.delete('sale-draft');
        })
        .catch(() => undefined);
      notify(
        draft.correction
          ? 'Corrected sale saved. Original receipt kept in history.'
          : 'Sale saved on this phone',
      );
      if (saveAnother && !draft.correction) {
        completed.current = false;
        setDraft(fresh());
        setTouched({});
        setConfirmNew(false);
        setAllowNegative(false);
        setRestored(false);
        focusNextCustomer.current = true;
        window.scrollTo(0, 0);
      } else navigate(`/sales/${sale.id}`, { replace: true });
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
  return (
    <div className="sale-page">
      <Link to="/" className="back-link">
        <ArrowLeft size={17} />
        Back to your shop
      </Link>
      <div className="page-heading">
        <div>
          <p className="subtle">A name, the goods, and what was paid.</p>
          <h1>{draft.correction ? 'Correct a sale' : 'Record a sale'}</h1>
        </div>
        <div className="draft-actions">
          <span className="draft-label" role="status">
            {draftStatus === 'saving'
              ? 'Saving draft…'
              : draftStatus === 'saved'
                ? 'Draft saved on this phone'
                : 'Couldn’t save draft. Keep this page open.'}
          </span>
          {draftStatus === 'failed' && (
            <Button variant="outline" size="sm" onClick={() => setRetryDraft((v) => v + 1)}>
              Retry draft save
            </Button>
          )}
          {hasDraftContent(draft) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setDiscardOpen(true)}
            >
              Discard draft
            </Button>
          )}
        </div>
      </div>
      {restored && (
        <div className="draft-banner" role="status">
          Your unfinished {draft.correction ? 'correction' : 'sale'} has been restored. Continue
          where you left off.
        </div>
      )}
      {draft.correction && (
        <section className="panel form-section correction-note">
          <h2>Corrected receipt</h2>
          <p>
            The original stays in history until you save. Saving reverses its payments and stock
            movements and records this replacement. Existing payments keep their collection dates.
          </p>
          <Link to={`/sales/${draft.correction.saleId}`}>View original receipt</Link>
          <div className="field">
            <label htmlFor="correction-reason">Reason for correction</label>
            <textarea
              id="correction-reason"
              disabled={saving}
              form="sale-form"
              {...fieldProps('correction-reason')}
              maxLength={500}
              value={draft.correction.reason}
              onChange={(e) =>
                update({ correction: { ...draft.correction!, reason: e.target.value } })
              }
            />
            {fieldError('correction-reason')}
          </div>
        </section>
      )}
      <form id="sale-form" onSubmit={submit} noValidate className="sale-layout">
        <fieldset className="sale-form-fields" disabled={saving}>
          <div className="sale-fields">
            <section className="panel form-section">
              <div className="form-section-heading">
                <span className="step">1</span>
                <h2>Who’s buying?</h2>
              </div>
              <div
                className="field suggestion-anchor"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setCustomerFocus(false);
                }}
              >
                <label htmlFor="customer-name">
                  Customer name <span className="required">*</span>
                </label>
                <input
                  id="customer-name"
                  {...fieldProps('customer-name')}
                  autoComplete="off"
                  placeholder="e.g. Mama Chika"
                  required
                  maxLength={160}
                  value={draft.customer}
                  onFocus={() => setCustomerFocus(true)}

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
                          document.getElementById(`item-${draft.rows[0].id}`)?.focus();
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
              {fieldError('customer-name')}
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
              {recentGoods.length > 0 && (
                <div className="recent-goods">
                  <p>
                    Recent goods <span>Tap to reuse the last unit and price</span>
                  </p>
                  <div>
                    {recentGoods.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => {
                          const row = draft.rows.find(
                            (r) => !r.name.trim() && !r.price && !r.label,
                          );
                          const linked = data.units.find(
                            (u) =>
                              u.id === item.productUnitId &&
                              normalize(u.label) === normalize(item.quantityLabel),
                          );
                          const values = {
                            name: item.name,
                            label: item.quantityLabel,
                            price: nairaInput(item.unitPriceKobo),
                            unitId: linked?.id ?? null,
                          };
                          if (row) {
                            rowUpdate(row.id, values);
                            document.getElementById(`qty-${row.id}`)?.focus();
                          } else if (draft.rows.length < 100)
                            update({ rows: [...draft.rows, { ...emptyRow(), ...values }] });
                        }}
                      >
                        {item.name}
                        <small>
                          {item.quantityLabel} · {money(item.unitPriceKobo)}
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
                      <div
                        className="field suggestion-anchor"
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget))
                            setItemFocus(null);
                        }}
                      >
                        <label htmlFor={`item-${row.id}`}>
                          Item name <span className="required">*</span>
                        </label>
                        <input
                          id={`item-${row.id}`}
                          {...fieldProps(`item-${row.id}`)}
                          placeholder="Type any goods, e.g. Rice"
                          value={row.name}
                          maxLength={160}
                          autoComplete="off"
                          onFocus={() => setItemFocus(row.id)}

                          onChange={(e) =>
                            rowUpdate(row.id, { name: e.target.value, unitId: null })
                          }
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
                                      document.getElementById(`qty-${row.id}`)?.focus();
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
                      {fieldError(`item-${row.id}`)}
                      <div className="item-numbers">
                        <div className="field">
                          <label htmlFor={`qty-${row.id}`}>Quantity</label>
                          <input
                            id={`qty-${row.id}`}
                            {...fieldProps(`qty-${row.id}`)}
                            inputMode="decimal"
                            value={row.quantity}
                            onChange={(e) => rowUpdate(row.id, { quantity: e.target.value })}
                          />
                          {fieldError(`qty-${row.id}`)}
                        </div>
                        <div className="field">
                          <label htmlFor={`unit-${row.id}`}>Unit / label</label>
                          <input
                            id={`unit-${row.id}`}
                            {...fieldProps(`unit-${row.id}`)}
                            placeholder="e.g. mudu"
                            maxLength={160}
                            value={row.label}
                            onChange={(e) =>
                              rowUpdate(row.id, { label: e.target.value, unitId: null })
                            }
                          />
                          {fieldError(`unit-${row.id}`)}
                        </div>
                        <div className="field">
                          <label htmlFor={`price-${row.id}`}>Price per unit (₦)</label>
                          <input
                            id={`price-${row.id}`}
                            {...fieldProps(`price-${row.id}`)}
                            inputMode="decimal"
                            placeholder="0"
                            value={row.price}
                            onChange={(e) => rowUpdate(row.id, { price: e.target.value })}
                          />
                          {fieldError(`price-${row.id}`)}
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
          <aside
            className="sale-summary"
            ref={summaryRef}
            tabIndex={-1}
            aria-label="Review payment and save"
          >
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
                    className={
                      draft.payment === value ? 'payment-option selected' : 'payment-option'
                    }
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
                    {...fieldProps('amount-received')}
                    inputMode="decimal"
                    placeholder="0"
                    value={draft.amount}
                    onChange={(e) => update({ amount: e.target.value })}
                  />
                </div>
              )}
              {fieldError('amount-received')}
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
                {saving ? 'Saving sale…' : draft.correction ? 'Save correction' : 'Save sale'}
              </Button>
              {!draft.correction && (
                <Button
                  type="submit"
                  variant="outline"
                  className="full-width save-another"
                  disabled={saving}
                  data-save-another="true"
                >
                  Save & record another
                </Button>
              )}
              <p className="local-save-note">
                <ShieldCheck size={14} />
                Saves on this phone, even offline
              </p>
            </section>
            <p className="quiet-note">
              Prices can change for this sale. Your saved records will keep these exact prices.
            </p>
          </aside>
        </fieldset>
      </form>
      <div className="mobile-checkout-bar">
        <div>
          <span>Sale total</span>
          <strong>{totalValid ? money(total) : '—'}</strong>
        </div>
        <Button
          type="button"
          onClick={() => {
            summaryRef.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
            summaryRef.current?.focus({ preventScroll: true });
          }}
        >
          Review & save
        </Button>
      </div>
      <Modal
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this draft?"
        description={
          draft.correction
            ? 'The original sale will stay unchanged.'
            : 'The unfinished sale will be removed from this phone.'
        }
      >
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => setDiscardOpen(false)}>
            Keep draft
          </Button>
          <Button
            onClick={() => {
              setDraft(fresh());
              setRestored(false);
              setTouched({});
              setError('');
              setConfirmNew(false);
              setAllowNegative(false);
              setDiscardOpen(false);
            }}
          >
            Discard draft
          </Button>
        </div>
      </Modal>
    </div>
  );
}
