import { localDay, paymentStatus, STORE_TIMEZONE, sumKobo, type Sale } from '../domain/index';
import type { Ledger } from './use-ledger';

export const salesPeriods = [
  ['all', 'All dates'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
  ['custom', 'Custom dates'],
] as const;
export type SalesPeriod = (typeof salesPeriods)[number][0];

export function salesDateRange(period: SalesPeriod, now = new Date()) {
  const today = localDay(now);
  const previousDay = (offset: number) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    return date.toISOString().slice(0, 10);
  };
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: previousDay(1), to: previousDay(1) };
    case 'week':
      return { from: previousDay(6), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    default:
      return { from: '', to: '' };
  }
}

const dayFormat = new Intl.DateTimeFormat('en-NG', {
  timeZone: STORE_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
export const formatSalesDay = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`));

export function salesView(
  data: Pick<Ledger, 'sales' | 'customers' | 'items' | 'payments'>,
  filters: { search: string; status: string; from: string; to: string },
) {
  const search = filters.search.trim().toLocaleLowerCase();
  const customers = new Map(data.customers.map((customer) => [customer.id, customer.name]));
  const goods = new Map<string, string[]>();
  for (const item of data.items) {
    const names = goods.get(item.saleId) ?? [];
    names.push(item.name);
    goods.set(item.saleId, names);
  }
  const sales = data.sales
    .filter((sale) => {
      const day = localDay(sale.occurredAt);
      return (
        (!filters.from || day >= filters.from) &&
        (!filters.to || day <= filters.to) &&
        `${customers.get(sale.customerId) ?? ''} ${(goods.get(sale.id) ?? []).join(' ')}`
          .toLocaleLowerCase()
          .includes(search) &&
        (filters.status === 'all' ||
          (filters.status === 'voided'
            ? sale.status === 'voided'
            : sale.status === 'active' && paymentStatus(sale, data.payments) === filters.status))
      );
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  const days = new Map<string, Sale[]>();
  for (const sale of sales) {
    const day = localDay(sale.occurredAt);
    const entries = days.get(day) ?? [];
    entries.push(sale);
    days.set(day, entries);
  }
  const groups = [...days].map(([day, entries]) => ({
    day,
    sales: entries,
    totalKobo: sumKobo(entries.filter((sale) => sale.status === 'active').map((s) => s.totalKobo)),
  }));
  return {
    groups,
    count: sales.length,
    totalKobo: sumKobo(groups.map((group) => group.totalKobo)),
  };
}
