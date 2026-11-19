import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerDB } from './database';
import { createLocalStore } from './store';
import { recordPayment, registerStock, saveSale, voidSale, recordCustomerPayment } from './ledger';
import {
  activePayments,
  receivedFor,
  allocatePayment,
  dashboard,
  type SaleInput,
} from '../domain/index';

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
  ],
  initialPaymentKobo: 200000,
  ...patch,
});
beforeEach(async () => {
  database = new LedgerDB(`corrections-${id()}`);
  await createLocalStore('Test shop', database);
});
afterEach(async () => {
  await database.delete();
});

describe('audited corrections and customer payments', () => {
  it('allocates oldest first and saves a grouped repayment atomically and idempotently', async () => {
    const first = await saveSale(input({ initialPaymentKobo: 0 }), database);
    const second = await saveSale(
      input({
        customerId: first.customerId,
        initialPaymentKobo: 0,
        occurredAt: '2026-11-15T10:00:00.000Z',
      }),
      database,
    );
    const allocations = allocatePayment([second, first], [], 750000);
    expect(allocations).toEqual([
      { saleId: first.id, amountKobo: 700000 },
      { saleId: second.id, amountKobo: 50000 },
    ]);
    const op = id();
    await Promise.all([
      recordCustomerPayment(first.customerId, allocations, op, database),
      recordCustomerPayment(first.customerId, allocations, op, database),
    ]);
    expect(await database.payments.count()).toBe(2);
    expect((await database.outbox.get(op))?.kind).toBe('payment.allocate');
    await expect(
      recordCustomerPayment(first.customerId, [{ saleId: first.id, amountKobo: 1 }], op, database),
    ).rejects.toThrow('already');
    const before = await database.payments.count();
    await expect(
      recordCustomerPayment(
        first.customerId,
        [
          { saleId: second.id, amountKobo: 10 },
          { saleId: first.id, amountKobo: 1 },
        ],
        id(),
        database,
      ),
    ).rejects.toThrow('balance changed');
    expect(await database.payments.count()).toBe(before);
    const outsider = await saveSale(
      input({ customerName: 'Another customer', initialPaymentKobo: 0 }),
      database,
    );
    await expect(
      recordCustomerPayment(
        first.customerId,
        [{ saleId: outsider.id, amountKobo: 10 }],
        id(),
        database,
      ),
    ).rejects.toThrow('no longer available');
  });
  it('voids once, restores stock and reverses payments while preserving the original receipt', async () => {
    await registerStock('Rice', 'mudu', '10', 350000, id(), database);
    const unit = (await database.productUnits.toArray())[0];
    const raw = input();
    raw.items[0].productUnitId = unit.id;
    const sale = await saveSale(raw, database);
    await recordPayment(sale.id, 100000, id(), database);
    const payments = await database.payments.toArray();
    const op = id(),
      expected = activePayments(sale.id, payments).map((p) => p.id);
    await voidSale(sale.id, 'Duplicate receipt', expected, op, database);
    await voidSale(sale.id, 'Duplicate receipt', expected, op, database);
    const voided = (await database.sales.get(sale.id))!;
    expect(voided).toMatchObject({
      status: 'voided',
      voidReason: 'Duplicate receipt',
      totalKobo: 700000,
    });
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('10');
    expect(await database.saleItems.count()).toBe(1);
    expect(await database.payments.count()).toBe(4);
    expect(receivedFor(sale.id, await database.payments.toArray())).toBe(0);
    expect(dashboard([voided], await database.payments.toArray()).owedKobo).toBe(0);
    await expect(recordPayment(sale.id, 1, id(), database)).rejects.toThrow('unavailable');
  });
  it('replaces a sale atomically, keeps collection dates and retries without doubling', async () => {
    await registerStock('Rice', 'mudu', '10', 350000, id(), database);
    const unit = (await database.productUnits.toArray())[0];
    const raw = input();
    raw.items[0].productUnitId = unit.id;
    const original = await saveSale(raw, database);
    await recordPayment(original.id, 100000, id(), database);
    const payments = activePayments(original.id, await database.payments.toArray()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    const correction = input({
      customerId: original.customerId,
      initialPaymentKobo: 300000,
      correction: {
        saleId: original.id,
        reason: 'Wrong quantity',
        expectedPaymentIds: payments.map((p) => p.id),
      },
    });
    correction.items[0].productUnitId = unit.id;
    correction.items[0].quantity = '3';
    const saved = await saveSale(correction, database);
    expect(await saveSale(correction, database)).toEqual(saved);
    await expect(
      saveSale(
        { ...correction, correction: { ...correction.correction!, expectedPaymentIds: [] } },
        database,
      ),
    ).rejects.toThrow('already');
    expect(saved.replacesSaleId).toBe(original.id);
    expect((await database.sales.get(original.id))?.status).toBe('voided');
    expect((await database.productUnits.get(unit.id))?.quantityOnHand).toBe('7');
    const replacements = activePayments(saved.id, await database.payments.toArray()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    expect(replacements.map((p) => [p.amountKobo, p.receivedAt])).toEqual(
      payments.map((p) => [p.amountKobo, p.receivedAt]),
    );
    expect((await database.outbox.get(correction.operationId))?.payload).toHaveProperty(
      'correction.reason',
      'Wrong quantity',
    );
    expect(await database.sales.count()).toBe(2);
  });
  it('rolls back every reversal if the replacement is invalid or payments changed', async () => {
    const original = await saveSale(input(), database);
    const payments = activePayments(original.id, await database.payments.toArray()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    const correction = input({
      customerId: original.customerId,
      correction: {
        saleId: original.id,
        reason: 'Wrong goods',
        expectedPaymentIds: payments.map((p) => p.id),
      },
    });
    correction.items[0].productUnitId = id();
    const before = {
      sales: await database.sales.toArray(),
      payments: await database.payments.toArray(),
      queue: await database.outbox.count(),
    };
    await expect(saveSale(correction, database)).rejects.toThrow('stock unit');
    expect(await database.sales.toArray()).toEqual(before.sales);
    expect(await database.payments.toArray()).toEqual(before.payments);
    expect(await database.outbox.count()).toBe(before.queue);
    await recordPayment(original.id, 1, id(), database);
    correction.items[0].productUnitId = null;
    await expect(saveSale(correction, database)).rejects.toThrow('Payments changed');
    expect((await database.sales.get(original.id))?.status).toBe('active');
    await expect(
      voidSale(
        original.id,
        'Changed payment',
        payments.map((p) => p.id),
        id(),
        database,
      ),
    ).rejects.toThrow('Payments changed');
  });

  it('trims the latest payments first and dates an increased paid amount at correction time', async () => {
    const original = await saveSale(input(), database);
    await recordPayment(original.id, 100000, id(), database);
    const payments = activePayments(original.id, await database.payments.toArray()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    const corrected = await saveSale(
      input({
        customerId: original.customerId,
        initialPaymentKobo: 100000,
        correction: {
          saleId: original.id,
          reason: 'Wrong amount received',
          expectedPaymentIds: payments.map((p) => p.id),
        },
      }),
      database,
    );
    const reduced = activePayments(corrected.id, await database.payments.toArray());
    expect(reduced.map((p) => [p.amountKobo, p.receivedAt])).toEqual([
      [100000, original.occurredAt],
    ]);
    const increased = await saveSale(
      input({
        customerId: original.customerId,
        initialPaymentKobo: 150000,
        correction: {
          saleId: corrected.id,
          reason: 'Additional amount received',
          expectedPaymentIds: reduced.map((p) => p.id),
        },
      }),
      database,
    );
    const final = activePayments(increased.id, await database.payments.toArray()).sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    expect(final).toHaveLength(2);
    expect(final[0]).toMatchObject({ amountKobo: 100000, receivedAt: original.occurredAt });
    expect(final[1]).toMatchObject({ amountKobo: 50000, receivedAt: increased.createdAt });
  });
});
