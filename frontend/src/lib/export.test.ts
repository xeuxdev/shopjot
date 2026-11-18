import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../db/database';
import { saveSale } from '../db/ledger';
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
    occurredAt: new Date().toISOString(),
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
  expect(await exported!.text()).toContain('"Customer","","299"');
  expect(click).toHaveBeenCalledOnce();
});

it('refuses an overflowing customer balance instead of downloading a rounded number', async () => {
  const first = await sale(Number.MAX_SAFE_INTEGER);
  await sale(2, 0, first.customerId);
  await expect(exportData('customers')).rejects.toThrow('too large');
  expect(exported).toBeUndefined();
  expect(click).not.toHaveBeenCalled();
});
