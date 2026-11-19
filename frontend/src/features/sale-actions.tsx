import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { activePayments, type Sale } from '../domain/index';
import { voidSale } from '../db/ledger';
import { Button, ErrorMessage, Modal } from '../components/ui';
import type { Ledger } from '../lib/use-ledger';
import { userMessage } from '../lib/errors';
import { prepareCorrection } from './sale-draft';

export function SaleActions({
  sale,
  data,
  notify,
}: {
  sale: Sale;
  data: Ledger;
  notify: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const expectedPaymentIds = useRef<string[]>([]);
  async function correct() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await prepareCorrection(sale, data);
      navigate('/sales/new');
    } catch (err) {
      setError(userMessage(err, 'Could not prepare the correction.'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    if (!reason.trim()) {
      setError('Enter a reason for voiding this sale.');
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await voidSale(sale.id, reason, expectedPaymentIds.current, operationId.current);
      setOpen(false);
      setReason('');
      operationId.current = crypto.randomUUID();
      notify('Sale voided. Original receipt and reversals kept in history.');
    } catch (err) {
      setError(userMessage(err, 'Could not void this sale.'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const replacement = data.sales.find((entry) => entry.replacesSaleId === sale.id);
  return (
    <section className="panel form-section sale-actions-panel">
      {sale.status === 'voided' ? (
        <>
          <h2>Voided receipt</h2>
          <p>{sale.voidReason ?? 'This receipt was voided.'}</p>
          {sale.voidedAt && (
            <p className="field-hint">
              {new Intl.DateTimeFormat('en-NG', {
                timeZone: 'Africa/Lagos',
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(sale.voidedAt))}
            </p>
          )}
          <p>
            The original goods and payment history are preserved. This sale is excluded from
            balances and totals.
          </p>
          {replacement && <Link to={`/sales/${replacement.id}`}>View replacement receipt</Link>}
        </>
      ) : (
        <>
          <h2>Correct this receipt</h2>
          <p>Keep the original in history with a reason for the change.</p>
          <div className="dialog-actions">
            <Button variant="outline" disabled={busy} onClick={() => void correct()}>
              Correct sale
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                expectedPaymentIds.current = activePayments(sale.id, data.payments).map(
                  (p) => p.id,
                );
                setError('');
                setOpen(true);
              }}
            >
              Void sale
            </Button>
          </div>
          {!open && <ErrorMessage message={error} />}
          {!open && error.includes('unfinished sale') && (
            <Link to="/sales/new">Resume unfinished sale</Link>
          )}
        </>
      )}
      {sale.replacesSaleId && (
        <Link to={`/sales/${sale.replacesSaleId}`}>View original receipt</Link>
      )}
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!locked.current) setOpen(value);
        }}
        title="Void this sale?"
        description="The original receipt stays in history. Recorded payments are reversed and linked goods are returned to stock. Handle any cash refund separately."
      >
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="void-reason">Reason for voiding</label>
            <textarea
              id="void-reason"
              autoFocus
              required
              maxLength={500}
              value={reason}
              disabled={busy}
              aria-invalid={!!error}
              aria-describedby={error ? 'void-error' : undefined}
              onChange={(event) => {
                setReason(event.target.value);
                setError('');
              }}
            />
          </div>
          <div id="void-error">
            <ErrorMessage message={error} />
          </div>
          <div className="dialog-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Keep sale
            </Button>
            <Button disabled={busy}>{busy ? 'Voiding…' : 'Confirm void'}</Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
