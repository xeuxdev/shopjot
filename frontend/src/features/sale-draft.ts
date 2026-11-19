import { activePayments, nairaInput, receivedFor, type Sale } from '../domain/index';
import { db } from '../db/database';
import type { Ledger } from '../lib/use-ledger';

export interface Row {
  id: string;
  name: string;
  quantity: string;
  label: string;
  price: string;
  unitId: string | null;
}
export interface Draft {
  id: string;
  operationId: string;
  customer: string;
  customerId?: string;
  rows: Row[];
  payment: 'full' | 'partial' | 'unpaid';
  amount: string;
  correction?: { saleId: string; reason: string; expectedPaymentIds: string[]; occurredAt: string };
}
export const emptyRow = (): Row => ({
  id: crypto.randomUUID(),
  name: '',
  quantity: '1',
  label: '',
  price: '',
  unitId: null,
});
export const fresh = (): Draft => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  customer: '',
  rows: [emptyRow()],
  payment: 'full',
  amount: '',
});
export const hasDraftContent = (draft: Draft) =>
  !!(
    draft.customer.trim() ||
    draft.correction ||
    draft.rows.some((row) => row.name || row.label || row.price || row.quantity !== '1')
  );

export async function prepareCorrection(sale: Sale, data: Ledger) {
  return db.transaction('rw', [db.metadata, db.sales, db.payments], async () => {
    const saved = (await db.metadata.get('sale-draft'))?.value as Draft | undefined;
    if (saved && !(await db.sales.get(saved.id)) && hasDraftContent(saved))
      throw new Error(
        'You have an unfinished sale. Resume or discard that draft before correcting this receipt.',
      );
    const current = await db.sales.get(sale.id);
    if (!current || current.status !== 'active')
      throw new Error('This sale is no longer active. Review its receipt.');
    const payments = await db.payments.where('saleId').equals(sale.id).toArray();
    const received = receivedFor(sale.id, payments);
    const draft: Draft = {
      ...fresh(),
      customer: data.customers.find((c) => c.id === sale.customerId)?.name ?? '',
      customerId: sale.customerId,
      rows: data.items
        .filter((i) => i.saleId === sale.id)
        .map((i) => ({
          id: crypto.randomUUID(),
          name: i.name,
          quantity: i.quantity,
          label: i.quantityLabel,
          price: nairaInput(i.unitPriceKobo),
          unitId: i.productUnitId,
        })),
      payment: received === sale.totalKobo ? 'full' : received > 0 ? 'partial' : 'unpaid',
      amount: nairaInput(received),
      correction: {
        saleId: sale.id,
        reason: '',
        occurredAt: sale.occurredAt,
        expectedPaymentIds: activePayments(sale.id, payments).map((p) => p.id),
      },
    };
    await db.metadata.put({ key: 'sale-draft', value: draft });
  });
}
