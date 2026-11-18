import {
  nairaInput,
  outstandingFor,
  paymentStatus,
  receivedFor,
  STORE_TIMEZONE,
  sumKobo,
  type Customer,
  type Payment,
  type Sale,
} from '../domain/index';
import type { StoreProfile } from '../db/store';

const reportDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: STORE_TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h12',
});

export function formatReportDate(value: string | Date): string {
  const parts = reportDate.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('day')}/${part('month')}/${part('year')}, ${part('hour')}:${part('minute')}:${part('second')} ${part('dayPeriod').toLowerCase()}`;
}

// Format exact kobo as decimal naira without floating-point division. CSV keeps
// the ungrouped number so spreadsheets can still calculate with the column.
export function reportNaira(kobo: number, grouped = false): string {
  const [whole, fraction = ''] = nairaInput(kobo).split('.');
  return `${grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}.${fraction.padEnd(2, '0')}`;
}

export interface ReportSource {
  store?: StoreProfile;
  sales: Sale[];
  customers: Customer[];
  payments: Payment[];
}

export function transactionReport(data: ReportSource, storeId: string, exportedAt: Date) {
  const customers = new Map(data.customers.map((customer) => [customer.id, customer.name]));
  const active = data.sales.filter((sale) => sale.status === 'active');
  return {
    storeId,
    storeName: data.store?.name ?? 'Your store',
    exportedAt: exportedAt.toISOString(),
    totals: {
      salesKobo: sumKobo(active.map((sale) => sale.totalKobo)),
      receivedKobo: sumKobo(active.map((sale) => receivedFor(sale.id, data.payments))),
      outstandingKobo: sumKobo(active.map((sale) => outstandingFor(sale, data.payments))),
    },
    rows: [...data.sales]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id))
      .map((sale) => ({
        id: sale.id,
        customer: customers.get(sale.customerId) ?? 'Customer',
        date: formatReportDate(sale.occurredAt),
        total: reportNaira(sale.totalKobo, true),
        received: reportNaira(receivedFor(sale.id, data.payments), true),
        outstanding: reportNaira(outstandingFor(sale, data.payments), true),
        status:
          sale.status === 'voided'
            ? 'Voided'
            : { paid: 'Paid', partial: 'Part payment', unpaid: 'Unpaid' }[
                paymentStatus(sale, data.payments)
              ],
      })),
  };
}
export type TransactionReport = ReturnType<typeof transactionReport>;
