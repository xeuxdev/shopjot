import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerDB, getIdentity } from './database';
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
beforeEach(() => {
  database = new LedgerDB(`test-${id()}`);
});
afterEach(async () => {
  await database.delete();
});

describe('atomic local ledger', () => {
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
  it('keeps a stable primary-device identity across restarts', async () => {
    const first = await getIdentity(database);
    expect(await getIdentity(database)).toEqual(first);
  });
});
