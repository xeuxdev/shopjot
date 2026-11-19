import { useRef, useState, type FormEvent } from 'react';
import {
  allocatePayment,
  money,
  nairaInput,
  outstandingFor,
  parseNaira,
  sumKobo,
} from '../domain/index';
import { recordCustomerPayment } from '../db/ledger';
import { Button, ErrorMessage, Modal } from '../components/ui';
import type { Ledger } from '../lib/use-ledger';
import { userMessage } from '../lib/errors';

export function CustomerPayment({
  customerId,
  data,
  notify,
}: {
  customerId: string;
  data: Ledger;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const unpaid = data.sales
    .filter((sale) => sale.customerId === customerId && outstandingFor(sale, data.payments) > 0)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const chosen = unpaid.filter((sale) => selected.includes(sale.id));
  const selectedBalance = sumKobo(chosen.map((sale) => outstandingFor(sale, data.payments)));
  let preview: ReturnType<typeof allocatePayment> = [];
  let previewError = '';
  try {
    if (amount) preview = allocatePayment(chosen, data.payments, parseNaira(amount));
  } catch (err) {
    previewError = userMessage(err, 'Enter a valid payment amount.');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError('');
    if (!preview.length || previewError) {
      setError(previewError || 'Select a sale and enter an amount greater than zero.');
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      await recordCustomerPayment(customerId, preview, operationId.current);
      operationId.current = crypto.randomUUID();
      setOpen(false);
      setAmount('');
      notify('Customer payment saved on this phone');
    } catch (err) {
      setError(
        userMessage(err, 'Could not save the payment. Review the current balances and try again.'),
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  if (!unpaid.length) return null;
  return (
    <>
      <Button
        onClick={() => {
          setSelected(unpaid.slice(0, 100).map((sale) => sale.id));
          setAmount('');
          setError('');
          setOpen(true);
        }}
      >
        Record payment
      </Button>
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!busy.current) setOpen(value);
        }}
        title="Record customer payment"
        description="Choose the sales being paid. The amount is applied to the oldest selected sale first."
      >
        <form onSubmit={submit} noValidate>
          <div className="allocation-sales">
            {unpaid.map((sale) => (
              <label className="allocation-sale" key={sale.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(sale.id)}
                  disabled={saving || (!selected.includes(sale.id) && selected.length >= 100)}
                  onChange={(event) => {
                    setError('');
                    setSelected((ids) =>
                      event.target.checked ? [...ids, sale.id] : ids.filter((id) => id !== sale.id),
                    );
                  }}
                />
                <span>
                  <strong>Sale #{sale.id.slice(0, 8)}</strong>
                  <small>
                    {new Intl.DateTimeFormat('en-NG', {
                      timeZone: 'Africa/Lagos',
                      dateStyle: 'medium',
                    }).format(new Date(sale.occurredAt))}
                  </small>
                </span>
                <strong>{money(outstandingFor(sale, data.payments))}</strong>
              </label>
            ))}
          </div>
          {unpaid.length > 100 && (
            <p className="field-hint">You can pay up to 100 sales at a time.</p>
          )}
          <div className="summary-row">
            <span>Selected balance</span>
            <strong>{money(selectedBalance)}</strong>
          </div>
          <div className="field">
            <label htmlFor="customer-payment-amount">Amount received (₦)</label>
            <input
              id="customer-payment-amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              disabled={saving}
              aria-invalid={!!previewError}
              aria-describedby={previewError ? 'allocation-error' : 'allocation-hint'}
              onChange={(event) => {
                setAmount(event.target.value);
                setError('');
              }}
            />
            <p className="field-hint" id="allocation-hint">
              Only the selected sales will receive this payment.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!selectedBalance || saving}
              onClick={() => {
                setAmount(nairaInput(selectedBalance));
                setError('');
              }}
            >
              Use selected balance
            </Button>
          </div>
          {previewError && (
            <p className="field-error" id="allocation-error">
              {previewError}
            </p>
          )}
          {!!preview.length && (
            <section
              className="allocation-preview"
              aria-label="Payment allocation"
              aria-live="polite"
            >
              <h3>This payment will cover</h3>
              {preview.map((allocation) => (
                <div className="summary-row" key={allocation.saleId}>
                  <span>Sale #{allocation.saleId.slice(0, 8)}</span>
                  <strong>{money(allocation.amountKobo)}</strong>
                </div>
              ))}
              <div className="summary-row owed">
                <span>Selected balance after payment</span>
                <strong>
                  {money(selectedBalance - sumKobo(preview.map((p) => p.amountKobo)))}
                </strong>
              </div>
            </section>
          )}
          <ErrorMessage message={error} />
          <Button className="full-width" disabled={saving}>
            {saving ? 'Saving…' : 'Save customer payment'}
          </Button>
        </form>
      </Modal>
    </>
  );
}
