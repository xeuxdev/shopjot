import { describe, expect, it } from 'vitest';
import { formatReportDate, reportNaira, transactionReport, type ReportSource } from './report';

describe('human-readable exports', () => {
  it('formats dates in Lagos with padded seconds and a 12-hour clock', () => {
    expect(formatReportDate('2026-11-18T00:40:43.000Z')).toBe('18/11/2026, 01:40:43 am');
    expect(formatReportDate('2026-11-18T12:40:43.000Z')).toBe('18/11/2026, 01:40:43 pm');
    expect(formatReportDate('2026-11-17T23:00:00.000Z')).toBe('18/11/2026, 12:00:00 am');
    expect(formatReportDate('2026-11-18T11:00:00.000Z')).toBe('18/11/2026, 12:00:00 pm');
  });
  it('preserves every kobo when converting to naira, including the largest supported amount', () => {
    expect(reportNaira(0)).toBe('0.00');
    expect(reportNaira(1)).toBe('0.01');
    expect(reportNaira(101)).toBe('1.01');
    expect(reportNaira(1245050, true)).toBe('12,450.50');
    expect(reportNaira(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(reportNaira(Number.MAX_SAFE_INTEGER, true)).toBe('90,071,992,547,409.91');
    expect(() => reportNaira(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it('reconciles active sales and repayments without mutating the stored records', () => {
    const time = '2026-11-18T12:40:43.000Z';
    const scoped = { storeId: 'store', createdAt: time };
    const source: ReportSource = {
      store: { id: 'store', name: 'Nnéka’s Shop' },
      customers: [
        {
          ...scoped,
          id: 'customer',
          name: 'Chịka',
          normalizedName: 'chịka',
          phone: null,
          updatedAt: time,
        },
      ],
      sales: [
        {
          ...scoped,
          id: 'sale',
          customerId: 'customer',
          totalKobo: 101,
          occurredAt: time,
          status: 'active',
        },
        {
          ...scoped,
          id: 'void',
          customerId: 'customer',
          totalKobo: 50000,
          occurredAt: time,
          status: 'voided',
        },
      ],
      payments: [
        {
          ...scoped,
          id: 'initial',
          saleId: 'sale',
          amountKobo: 1,
          receivedAt: time,
          reversalOf: null,
        },
        {
          ...scoped,
          id: 'later',
          saleId: 'sale',
          amountKobo: 50,
          receivedAt: time,
          reversalOf: null,
        },
        {
          ...scoped,
          id: 'void-payment',
          saleId: 'void',
          amountKobo: 50000,
          receivedAt: time,
          reversalOf: null,
        },
      ],
    };
    const saved = structuredClone(source);
    const report = transactionReport(source, 'store', new Date(time));
    expect(report.storeName).toBe('Nnéka’s Shop');
    expect(report.totals).toEqual({ salesKobo: 101, receivedKobo: 51, outstandingKobo: 50 });
    expect(report.rows[0]).toMatchObject({
      customer: 'Chịka',
      total: '1.01',
      received: '0.51',
      outstanding: '0.50',
      date: '18/11/2026, 01:40:43 pm',
    });
    expect(report.rows[1].status).toBe('Voided');
    expect(source).toEqual(saved);
  });
});
