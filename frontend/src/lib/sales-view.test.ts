import { describe, expect, it } from 'vitest';
import { salesDateRange, salesView } from './sales-view';
import type { Sale } from '../domain/index';

const sale = (
  id: string,
  occurredAt: string,
  totalKobo: number,
  status: Sale['status'] = 'active',
): Sale => ({
  id,
  occurredAt,
  totalKobo,
  status,
  storeId: 'store',
  customerId: 'customer',
  createdAt: occurredAt,
});
const source = {
  customers: [
    {
      id: 'customer',
      name: 'Amina',
      normalizedName: 'amina',
      storeId: 'store',
      createdAt: '',
      updatedAt: '',
      phone: null,
    },
  ],
  sales: [
    sale('before', '2026-11-20T22:59:59.999Z', 10000),
    sale('start', '2026-11-20T23:00:00.000Z', 10001),
    sale('end', '2026-11-21T22:59:59.999Z', 20002),
    sale('after', '2026-11-21T23:00:00.000Z', 40000),
    sale('void', '2026-11-21T09:00:00.000Z', 99999, 'voided'),
  ],
  items: [
    {
      id: 'item',
      saleId: 'start',
      name: 'Rice',
      quantity: '1',
      quantityLabel: 'bag',
      unitPriceKobo: 10001,
      lineTotalKobo: 10001,
      position: 0,
      productUnitId: null,
      storeId: 'store',
      createdAt: '',
    },
  ],
  payments: [
    {
      id: 'payment',
      saleId: 'start',
      amountKobo: 10001,
      receivedAt: '2026-11-22T10:00:00Z',
      reversalOf: null,
      storeId: 'store',
      createdAt: '',
    },
  ],
};
const filters = { search: '', status: 'all', from: '', to: '' };

describe('sale date shortcuts', () => {
  it('uses the shop day when the UTC date is still yesterday', () => {
    const now = new Date('2026-11-20T23:30:00Z');
    expect(salesDateRange('today', now)).toEqual({ from: '2026-11-21', to: '2026-11-21' });
    expect(salesDateRange('yesterday', now)).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    expect(salesDateRange('week', now)).toEqual({ from: '2026-11-15', to: '2026-11-21' });
    expect(salesDateRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-21' });
    expect(salesDateRange('all', now)).toEqual({ from: '', to: '' });
  });
  it('handles year boundaries and leap days', () => {
    expect(salesDateRange('week', new Date('2026-01-01T10:00:00Z'))).toEqual({
      from: '2025-12-26',
      to: '2026-01-01',
    });
    expect(salesDateRange('yesterday', new Date('2024-03-01T10:00:00Z'))).toEqual({
      from: '2024-02-29',
      to: '2024-02-29',
    });
  });
});

describe('filtered daily sales totals', () => {
  it('includes both date boundaries in Lagos and excludes voided amounts', () => {
    const view = salesView(source, { ...filters, from: '2026-11-21', to: '2026-11-21' });
    expect(view.count).toBe(3);
    expect(view.totalKobo).toBe(30003);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].sales.map((s) => s.id)).toEqual(['end', 'void', 'start']);
  });
  it('groups newest days first and reconciles daily totals with the overall total', () => {
    const original = structuredClone(source);
    const view = salesView(source, filters);
    expect(view.groups.map((group) => [group.day, group.totalKobo])).toEqual([
      ['2026-11-22', 40000],
      ['2026-11-21', 30003],
      ['2026-11-20', 10000],
    ]);
    expect(view.totalKobo).toBe(80003);
    expect(source).toEqual(original);
  });
  it('supports open date ranges and empty results', () => {
    expect(salesView(source, { ...filters, from: '2026-11-22' }).totalKobo).toBe(40000);
    expect(salesView(source, { ...filters, to: '2026-11-20' }).totalKobo).toBe(10000);
    expect(salesView(source, { ...filters, from: '2026-12-01' })).toEqual({
      count: 0,
      totalKobo: 0,
      groups: [],
    });
  });
  it('applies search and payment status to totals, using sale dates rather than payment dates', () => {
    expect(
      salesView(source, {
        ...filters,
        search: ' rICE ',
        status: 'paid',
        from: '2026-11-21',
        to: '2026-11-21',
      }).totalKobo,
    ).toBe(10001);
    expect(salesView(source, { ...filters, search: 'AMINA', status: 'unpaid' }).totalKobo).toBe(
      70002,
    );
    const voided = salesView(source, { ...filters, status: 'voided' });
    expect(voided.count).toBe(1);
    expect(voided.totalKobo).toBe(0);
    expect(voided.groups[0].totalKobo).toBe(0);
  });
});
