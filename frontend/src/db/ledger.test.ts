import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerDB, getIdentity } from './database';
import { createLocalStore } from './store';
import { adjustStock, recordPayment, registerStock, saveSale } from './ledger';
import { outstandingFor, type SaleInput } from '../domain/index';

const id = () => crypto.randomUUID();
let database: LedgerDB;
const input = (patch: Partial<SaleInput> = {}): SaleInput => ({
  id: id(),
  operationId: id(),
  customerName: 'Mama Chika',
  occurredAt: '2026-11-14T10:00:00.000Z',
  items: [
    {
      id: id(),
      name: 'Rice',
      quantity: '2',
      quantityLabel: 'mudu',
      unitPriceKobo: 350000,
      productUnitId: null,
    },
    {
      id: id(),
      name: 'Groundnut oil',
      quantity: '1',
      quantityLabel: 'bottle',
      unitPriceKobo: 450000,
      productUnitId: null,
    },
  ],
  initialPaymentKobo: 500000,
  ...patch,
});
beforeEach(async () => {
  database = new LedgerDB(`test-${id()}`);
  await createLocalStore('Test shop', database);
});
afterEach(async () => {
  await database.delete();
});

describe('atomic local ledger', () => {
  it('allows an already restored phone with a legacy read-only flag to save sales', async () => {
    const identity = await getIdentity(database);
    const account = {
      ...identity,
      userId: id(),
      email: 'owner@example.test',
      storeName: 'Test shop',
      writer: false,
      restoreReady: true,
    };
    await database.metadata.put({ key: 'account', value: account });
    expect((await saveSale(input(), database)).totalKobo).toBe(1150000);
    await database.metadata.put({ key: 'account', value: { ...account, restoreReady: false } });
    await expect(saveSale(input(), database)).rejects.toThrow('restore');
    await database.metadata.put({ key: 'account', value: { ...account, signedOut: true } });
    await expect(saveSale(input(), database)).rejects.toThrow('Sign in');
    expect(await database.sales.count()).toBe(1);
  });
  it('saves a sale, customer, items, payment and queue atomically and survives reopen', async () => {
    const sale = await saveSale(input(), database);
    expect(sale.totalKobo).toBe(1150000);
    expect(await database.customers.count()).toBe(1);
    expect(await database.saleItems.count()).toBe(2);
    expect(await database.payments.count()).toBe(1);
    expect(await database.outbox.count()).toBe(1);
    const name = database.name;
    database.close();
    database = new LedgerDB(name);
    expect(await database.sales.get(sale.id)).toEqual(sale);
    expect(outstandingFor(sale, await database.payments.toArray())).toBe(650000);
  });
  it('deduplicates concurrent repeat saves and repayments', async () => {
    const raw = input();
    await Promise.all([saveSale(raw, database), saveSale(raw, database)]);
    expect(await database.sales.count()).toBe(1);
    expect(await database.payments.count()).toBe(1);
    const op = id();
    await Promise.all([
      recordPayment(raw.id, 200000, op, database),
      recordPayment(raw.id, 200000, op, database),
    ]);
    expect(await database.payments.count()).toBe(2);
    expect(
      outstandingFor((await database.sales.get(raw.id))!, await database.payments.toArray()),
    ).toBe(450000);
  });
  it('rejects changed sale contents under an already saved draft ID', async () => {
    const raw = input();
    const saved = await saveSale(raw, database);
    const changed = structuredClone(raw);
    changed.items[0].unitPriceKobo++;
    await expect(saveSale(changed, database)).rejects.toThrow('already');
    await expect(saveSale({ ...raw, initialPaymentKobo: 1 }, database)).rejects.toThrow('already');
    await expect(saveSale({ ...raw, customerName: 'Another customer' }, database)).rejects.toThrow(
      'already',
    );
    expect(await database.sales.get(saved.id)).toEqual(saved);
    expect(await database.payments.count()).toBe(1);
    expect(await database.outbox.count()).toBe(1);
    // A retry from the form gets a new attempt time, but must return the original receipt.
    expect(await saveSale({ ...raw, occurredAt: '2026-11-15T10:00:00.000Z' }, database)).toEqual(
      saved,
    );
  });
  it('rejects reusing a payment operation for another amount or sale', async () => {
    const first = await saveSale(input(), database);
    const second = await saveSale(input(), database);
    const operationId = id();
    await recordPayment(first.id, 200000, operationId, database);
    await expect(recordPayment(first.id, 100000, operationId, database)).rejects.toThrow('already');
    await expect(recordPayment(second.id, 200000, operationId, database)).rejects.toThrow(
      'already',
    );
    expect(await database.payments.count()).toBe(3);
    expect(outstandingFor(first, await database.payments.toArray())).toBe(450000);
    expect(outstandingFor(second, await database.payments.toArray())).toBe(650000);
  });
  it('serializes distinct concurrent repayments so they cannot overpay', async () => {
    const sale = await saveSale(input(), database);
    const results = await Promise.allSettled([
      recordPayment(sale.id, 400000, id(), database),
      recordPayment(sale.id, 400000, id(), database),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await database.payments.count()).toBe(2);
    expect(outstandingFor(sale, await database.payments.toArray())).toBe(250000);
  });
  it('rejects invalid money values and overflowing totals without changing any records', async () => {
    for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(saveSale(input({ initialPaymentKobo: amount }), database)).rejects.toThrow();
      const raw = input();
      raw.items[0].unitPriceKobo = amount;
      await expect(saveSale(raw, database)).rejects.toThrow();
    }
    const raw = input({ initialPaymentKobo: 0 });
    raw.items = raw.items.map((item) => ({
      ...item,
      quantity: '1',
      unitPriceKobo: Number.MAX_SAFE_INTEGER,
    }));
    await expect(saveSale(raw, database)).rejects.toThrow('too large');
    expect(await database.sales.count()).toBe(0);
    expect(await database.saleItems.count()).toBe(0);
    expect(await database.payments.count()).toBe(0);
    expect(await database.customers.count()).toBe(0);
    expect(await database.outbox.count()).toBe(0);
  });
  it('stores per-line rounding and one-kobo repayments exactly across reload', async () => {
    const raw = input({ initialPaymentKobo: 1 });
    raw.items = raw.items.map((item) => ({ ...item, quantity: '0.5', unitPriceKobo: 1 }));
    const sale = await saveSale(raw, database);
    expect(sale.totalKobo).toBe(2);
    expect((await database.saleItems.toArray()).map((item) => item.lineTotalKobo)).toEqual([1, 1]);
    await recordPayment(sale.id, 1, id(), database);
    database.close();
    await database.open();
    expect(
      outstandingFor((await database.sales.get(sale.id))!, await database.payments.toArray()),
    ).toBe(0);
    await expect(recordPayment(sale.id, 1, id(), database)).rejects.toThrow('exceed');
  });
  it('rejects overpayment and rolls back failed writes without partial records', async () => {
    await expect(saveSale(input({ initialPaymentKobo: 2000000 }), database)).rejects.toThrow();
    expect(await database.sales.count()).toBe(0);
    expect(await database.customers.count()).toBe(0);
    const sale = await saveSale(input(), database);
    await expect(recordPayment(sale.id, 650001, id(), database)).rejects.toThrow('exceed');
    expect(await database.payments.count()).toBe(1);
  });
  it('selects the exact sale for repayment when one customer has two unpaid sales', async () => {
    const first = await saveSale(input({ initialPaymentKobo: 0 }), database);
    const second = await saveSale(
      input({ initialPaymentKobo: 0, customerId: first.customerId }),
      database,
    );
    await recordPayment(second.id, 100000, id(), database);
    const ps = await database.payments.toArray();
    expect(outstandingFor(first, ps)).toBe(1150000);
    expect(outstandingFor(second, ps)).toBe(1050000);
    expect(await database.customers.count()).toBe(1);
  });
  it('rejects customers or stock references belonging to a different local store', async () => {
    const sale = await saveSale(input(), database);
    const customer = (await database.customers.get(sale.customerId))!;
    await database.customers.update(customer.id, { storeId: id() });
    await expect(saveSale(input({ customerId: customer.id }), database)).rejects.toThrow(
      'customer',
    );
  });
  it('rejects malformed quantities and required names without a write', async () => {
    for (const name of ['', ' '])
      await expect(saveSale(input({ customerName: name }), database)).rejects.toThrow();
    const raw = input();
    raw.items[0].quantity = '-1';
    await expect(saveSale(raw, database)).rejects.toThrow();
    expect(await database.outbox.count()).toBe(0);
  });
});
describe('explicit inventory association', () => {
  async function stock() {
    await registerStock('Rice', 'mudu', '15', 350000, id(), database);
    return (await database.productUnits.toArray())[0];
  }
  it('deducts exactly once only from an explicitly linked compatible unit', async () => {
    const unit = await stock();
    const raw = input();
    raw.items[0].productUnitId = unit.id;
    await saveSale(raw, database);
    await saveSale(raw, database);
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('13');
    expect(await database.stockMovements.count()).toBe(2);
    const unlinked = input();
    unlinked.items[0].quantityLabel = 'paint';
    await saveSale(unlinked, database);
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('13');
  });
  it('retains historical prices and records manual count adjustments', async () => {
    const unit = await stock();
    const raw = input();
    raw.items[0].productUnitId = unit.id;
    await saveSale(raw, database);
    await database.productUnits.update(unit.id, { suggestedUnitPriceKobo: 900000 });
    const op = id();
    await adjustStock(unit.id, '12.125', op, database);
    await adjustStock(unit.id, '12.125', op, database);
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('12.125');
    const movements = await database.stockMovements.toArray();
    expect(movements.filter((m) => m.reason === 'manual_adjustment')).toHaveLength(1);
    expect((await database.saleItems.get(raw.items[0].id))?.unitPriceKobo).toBe(350000);
  });
  it('rejects changed stock operations instead of silently losing a new count', async () => {
    const operationId = id();
    await registerStock('Rice', 'mudu', '15', 350000, operationId, database);
    await registerStock('Rice', 'mudu', '15.000', 350000, operationId, database);
    await expect(
      registerStock('Rice', 'mudu', '16', 350000, operationId, database),
    ).rejects.toThrow('already');
    const unit = (await database.productUnits.toArray())[0];
    await expect(adjustStock(unit.id, '10', operationId, database)).rejects.toThrow('already');
    const adjustmentId = id();
    await adjustStock(unit.id, '12.125', adjustmentId, database);
    await expect(adjustStock(unit.id, '13', adjustmentId, database)).rejects.toThrow('already');
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('12.125');
    expect(await database.stockMovements.count()).toBe(2);
  });
  it('rolls back all tables when a later row has an invalid stock association', async () => {
    const unit = await stock();
    const raw = input();
    raw.items[0].productUnitId = unit.id;
    raw.items[1].productUnitId = id();
    await expect(saveSale(raw, database)).rejects.toThrow('stock unit');
    expect(await database.customers.count()).toBe(0);
    expect(await database.sales.count()).toBe(0);
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('15');
    expect(await database.stockMovements.count()).toBe(1);
    expect(await database.outbox.count()).toBe(1);
  });
  it('requires explicit permission for insufficient stock, including repeated rows', async () => {
    const unit = await stock();
    const raw = input();
    raw.items = [raw.items[0], { ...raw.items[0], id: id() }].map((i) => ({
      ...i,
      quantity: '10',
      productUnitId: unit.id,
    }));
    await expect(saveSale(raw, database)).rejects.toThrow('Insufficient stock');
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('15');
    await saveSale({ ...raw, allowNegativeStock: true }, database);
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('-5');
  });
  it('accepts arbitrary unit labels and prevents case-insensitive duplicate product units', async () => {
    await registerStock('Garri', 'small heap', '0.125', 100, id(), database);
    await expect(registerStock('garri', 'Small Heap', '2', 100, id(), database)).rejects.toThrow(
      'already',
    );
    expect(await database.productUnits.count()).toBe(1);
  });
  it('keeps a stable device identity across restarts', async () => {
    const first = await getIdentity(database);
    expect(await getIdentity(database)).toEqual(first);
  });
});
