import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../db/database';
import { saveSale, voidSale } from '../db/ledger';
import { createLocalStore } from '../db/store';
import { exportData } from './export';

let exported: Blob | undefined;
const click = vi.fn();

beforeEach(async () => {
  await db.open();
  await createLocalStore('Export test shop');
  exported = undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    exported = blob as Blob;
    return 'blob:test-export';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('document', { createElement: () => ({ click }) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  click.mockClear();
  await db.delete();
});

async function sale(totalKobo: number, initialPaymentKobo = 0, customerId?: string) {
  return saveSale({
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    customerId,
    customerName: 'Customer',
    occurredAt: '2026-11-18T12:40:43.000Z',
    initialPaymentKobo,
    items: [
      {
        id: crypto.randomUUID(),
        name: 'Item',
        quantity: '1',
        quantityLabel: 'piece',
        unitPriceKobo: totalKobo,
        productUnitId: null,
      },
    ],
  });
}

it('exports exact customer balances after part payments across multiple sales', async () => {
  const first = await sale(101, 1);
  await sale(201, 2, first.customerId);
  await exportData('customers');
  expect(await exported!.text()).toContain('"Customer","","2.99"');
  expect(click).toHaveBeenCalledOnce();
});

it('refuses an overflowing customer balance instead of downloading a rounded number', async () => {
  const first = await sale(Number.MAX_SAFE_INTEGER);
  await sale(2, 0, first.customerId);
  await expect(exportData('customers')).rejects.toThrow('too large');
  expect(exported).toBeUndefined();
  expect(click).not.toHaveBeenCalled();
});

it('exports sales with exact decimal naira and a readable Lagos timestamp', async () => {
  await sale(1245050, 45050);
  await exportData('sales');
  const csv = await exported!.text();
  expect(csv).toContain('"Date (Africa/Lagos)","Total (NGN)","Outstanding (NGN)"');
  expect(csv).toContain('"18/11/2026, 01:40:43 pm","12450.50","12000.00","partial"');
  expect(csv).not.toContain('2026-11-18T12:40:43.000Z');
});

it('keeps the JSON backup in integer kobo and ISO timestamps', async () => {
  await sale(101, 1);
  await exportData('json');
  const backup = JSON.parse(await exported!.text());
  expect(backup.sales[0]).toMatchObject({ totalKobo: 101, occurredAt: '2026-11-18T12:40:43.000Z' });
  expect(backup.payments[0].amountKobo).toBe(1);
});

it('includes void status and the audit reason in sales exports', async () => {
  const saved = await sale(100, 0);
  await voidSale(saved.id, 'Duplicate receipt', [], crypto.randomUUID());
  await exportData('sales');
  const csv = await exported!.text();
  expect(csv).toContain('"Void reason","Voided at (Africa/Lagos)","Replaces sale ID"');
  expect(csv).toContain('"0.00","voided","Duplicate receipt"');
});
