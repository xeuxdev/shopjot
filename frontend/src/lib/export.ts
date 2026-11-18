import { db, getIdentity } from '../db/database';
import { outstandingFor, paymentStatus, sumKobo } from '../domain/index';
import type { StoreProfile } from '../db/store';
import { formatReportDate, reportNaira, transactionReport } from './report';
export type ExportKind = 'sales' | 'customers' | 'json' | 'pdf';
function download(name: string, data: string | ArrayBuffer, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Prefix spreadsheet formula characters; quoting alone does not prevent formula injection.
function cell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}
export async function exportData(kind: ExportKind) {
  const identity = await getIdentity();
  const data = await db.transaction('r', db.tables, async () => ({
    store: (await db.metadata.get('store'))?.value as StoreProfile | undefined,
    customers: await db.customers.where('storeId').equals(identity.storeId).toArray(),
    sales: await db.sales.where('storeId').equals(identity.storeId).toArray(),
    saleItems: await db.saleItems.where('storeId').equals(identity.storeId).toArray(),
    payments: await db.payments.where('storeId').equals(identity.storeId).toArray(),
    products: await db.products.where('storeId').equals(identity.storeId).toArray(),
    productUnits: await db.productUnits.where('storeId').equals(identity.storeId).toArray(),
    stockMovements: await db.stockMovements.where('storeId').equals(identity.storeId).toArray(),
    outbox: await db.outbox.where('storeId').equals(identity.storeId).toArray(),
  }));
  const exportedAt = new Date();
  const date = exportedAt.toISOString().slice(0, 10);
  if (kind === 'json')
    return download(
      `shopjot-${identity.storeId}-${date}.json`,
      JSON.stringify(
        { version: 1, exportedAt: exportedAt.toISOString(), storeId: identity.storeId, ...data },
        null,
        2,
      ),
      'application/json',
    );
  if (kind === 'pdf') {
    const report = transactionReport(data, identity.storeId, exportedAt);
    const { createTransactionsPdf } = await import('./export-pdf');
    return download(
      `shopjot-transactions-${identity.storeId}-${date}.pdf`,
      await createTransactionsPdf(report),
      'application/pdf',
    );
  }
  const rows =
    kind === 'sales'
      ? [
          [
            'Sale ID',
            'Customer',
            'Date (Africa/Lagos)',
            'Total (NGN)',
            'Outstanding (NGN)',
            'Payment status',
          ],
          ...data.sales.map((s) => [
            s.id,
            data.customers.find((c) => c.id === s.customerId)?.name,
            formatReportDate(s.occurredAt),
            reportNaira(s.totalKobo),
            reportNaira(outstandingFor(s, data.payments)),
            paymentStatus(s, data.payments),
          ]),
        ]
      : [
          ['Customer ID', 'Name', 'Phone', 'Outstanding (NGN)'],
          ...data.customers.map((c) => [
            c.id,
            c.name,
            c.phone,
            reportNaira(
              sumKobo(
                data.sales
                  .filter((s) => s.customerId === c.id)
                  .map((s) => outstandingFor(s, data.payments)),
              ),
            ),
          ]),
        ];
  download(
    `shopjot-${kind}-${identity.storeId}-${date}.csv`,
    '\ufeff' + rows.map((row) => row.map(cell).join(',')).join('\r\n'),
    'text/csv;charset=utf-8',
  );
}
