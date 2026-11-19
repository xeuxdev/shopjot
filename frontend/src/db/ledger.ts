import {
  z,
  saleInputSchema,
  lineTotal,
  sumKobo,
  normalize,
  outstandingFor,
  decimalToMilli,
  milliToDecimal,
  nameSchema,
  koboSchema,
  activePayments,
  type Payment,
  type SaleInput,
  type SyncOperation,
} from '../domain/index';
import { db, getIdentity, type DeviceIdentity, type LedgerDB } from './database';
import { assertCanWrite, enqueue } from './queue';

function replayConflict() {
  return new Error(
    'This entry was already saved with different contents. Open the saved record to check it, then start a new entry if needed.',
  );
}

type OperationPayloads = {
  [K in SyncOperation['kind']]: Extract<SyncOperation, { kind: K }>['payload'];
};

async function isReplay<K extends SyncOperation['kind']>(
  database: LedgerDB,
  identity: DeviceIdentity,
  operationId: string,
  kind: K,
  matches: (payload: OperationPayloads[K]) => boolean,
) {
  const previous = await database.outbox.get(operationId);
  if (!previous) return false;
  if (
    previous.storeId !== identity.storeId ||
    previous.deviceId !== identity.deviceId ||
    previous.kind !== kind ||
    !matches(previous.payload as OperationPayloads[K])
  )
    throw replayConflict();
  return true;
}

function sameSaleRequest(
  saved: Extract<SyncOperation, { kind: 'sale.create' }>['payload'],
  input: SaleInput,
) {
  // The form stamps each save attempt with a new time. A matching retry returns
  // the original receipt and time; its customer, goods and money must still match.
  return (
    saved.sale.id === input.id &&
    saved.correction?.saleId === input.correction?.saleId &&
    saved.correction?.reason === input.correction?.reason &&
    [...(saved.correction?.expectedPaymentIds ?? [])].sort().join() ===
      [...(input.correction?.expectedPaymentIds ?? [])].sort().join() &&
    (!input.correction || saved.sale.occurredAt === input.occurredAt) &&
    (input.customerId
      ? saved.customer.id === input.customerId
      : saved.customer.name === input.customerName) &&
    sumKobo(
      saved.replacementPayments?.map((p) => p.amountKobo) ?? [saved.payment?.amountKobo ?? 0],
    ) === input.initialPaymentKobo &&
    saved.items.length === input.items.length &&
    saved.items.every((item, position) => {
      const incoming = input.items[position];
      return (
        item.id === incoming.id &&
        item.name === incoming.name &&
        decimalToMilli(item.quantity) === decimalToMilli(incoming.quantity) &&
        item.quantityLabel === incoming.quantityLabel &&
        item.unitPriceKobo === incoming.unitPriceKobo &&
        item.productUnitId === incoming.productUnitId
      );
    })
  );
}

export async function saveSale(raw: SaleInput, database: LedgerDB = db) {
  const input = saleInputSchema.parse(raw);
  const identity = await getIdentity(database);
  const { storeId } = identity;
  return database.transaction(
    'rw',
    [
      database.customers,
      database.sales,
      database.saleItems,
      database.payments,
      database.productUnits,
      database.stockMovements,
      database.outbox,
      database.metadata,
    ],
    async () => {
      await assertCanWrite(database);
      const replay = await isReplay(
        database,
        identity,
        input.operationId,
        'sale.create',
        (payload) => sameSaleRequest(payload, input),
      );
      const existingSale = await database.sales.get(input.id);
      if (existingSale) {
        if (!replay || existingSale.storeId !== storeId) throw replayConflict();
        return existingSale;
      }
      if (replay)
        throw new Error(
          'The saved sale could not be found. Keep this ledger and review its records.',
        );
      const createdAt = new Date().toISOString();
      if (input.correction) {
        const original = await database.sales.get(input.correction.saleId);
        if (original?.occurredAt !== input.occurredAt)
          throw new Error(
            'A correction must preserve the original sale date. Reopen the original receipt.',
          );
      }
      const originalPayments = input.correction
        ? activePayments(input.correction.saleId, await database.payments.toArray()).sort(
            (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
          )
        : [];
      const correction = input.correction
        ? await reverseSale(
            database,
            storeId,
            input.correction.saleId,
            input.correction.reason,
            createdAt,
            input.correction.expectedPaymentIds,
          )
        : undefined;
      let customer = input.customerId ? await database.customers.get(input.customerId) : undefined;
      if (input.customerId && (!customer || customer.storeId !== storeId))
        throw new Error('Choose an existing customer again.');
      if (!customer) {
        customer = {
          id: crypto.randomUUID(),
          storeId,
          name: input.customerName,
          normalizedName: normalize(input.customerName),
          phone: null,
          createdAt,
          updatedAt: createdAt,
        };
        await database.customers.add(customer);
      }
      const items = input.items.map((item, position) => ({
        ...item,
        position,
        storeId,
        saleId: input.id,
        createdAt,
        lineTotalKobo: lineTotal(item.quantity, item.unitPriceKobo),
      }));
      const movements = [];
      for (const item of items) {
        if (!item.productUnitId) continue;
        const unit = await database.productUnits.get(item.productUnitId);
        if (
          !unit ||
          unit.storeId !== storeId ||
          unit.normalizedLabel !== normalize(item.quantityLabel)
        )
          throw new Error(
            'The selected stock unit has changed. Select it again or save this item as untracked.',
          );
        const remaining = decimalToMilli(unit.quantityOnHand) - decimalToMilli(item.quantity);
        if (remaining < 0n && !input.allowNegativeStock)
          throw new Error('Insufficient stock. Review the stock warning before saving.');
        await database.productUnits.update(unit.id, {
          quantityOnHand: milliToDecimal(remaining),
          updatedAt: createdAt,
        });
        const movement = {
          id: crypto.randomUUID(),
          storeId,
          productUnitId: unit.id,
          saleItemId: item.id,
          quantityDelta: milliToDecimal(-decimalToMilli(item.quantity)),
          reason: 'sale' as const,
          occurredAt: input.occurredAt,
          createdAt,
        };
        await database.stockMovements.add(movement);
        movements.push(movement);
      }
      const sale = {
        id: input.id,
        storeId,
        customerId: customer.id,
        totalKobo: sumKobo(items.map((i) => i.lineTotalKobo)),
        occurredAt: input.occurredAt,
        status: 'active' as const,
        createdAt,
        ...(correction ? { replacesSaleId: correction.saleId } : {}),
      };
      await database.sales.add(sale);
      await database.saleItems.bulkAdd(items);
      const payment =
        input.initialPaymentKobo > 0 && !correction
          ? {
              id: crypto.randomUUID(),
              storeId,
              saleId: sale.id,
              amountKobo: input.initialPaymentKobo,
              receivedAt: input.occurredAt,
              createdAt,
              reversalOf: null,
            }
          : null;
      if (payment) await database.payments.add(payment);
      // Keep prior collection dates when correcting a receipt. A changed paid
      // amount trims the latest payments first; any extra is collected now.
      const replacementPayments = correction ? ([] as Payment[]) : undefined;
      if (replacementPayments) {
        let remaining = input.initialPaymentKobo;
        for (const original of originalPayments) {
          const amountKobo = Math.min(remaining, original.amountKobo);
          if (amountKobo > 0)
            replacementPayments.push({
              ...original,
              id: crypto.randomUUID(),
              saleId: sale.id,
              amountKobo,
              createdAt,
              reversalOf: null,
            });
          remaining -= amountKobo;
        }
        if (remaining > 0)
          replacementPayments.push({
            id: crypto.randomUUID(),
            storeId,
            saleId: sale.id,
            amountKobo: remaining,
            receivedAt: createdAt,
            createdAt,
            reversalOf: null,
          });
        await database.payments.bulkAdd(replacementPayments);
      }
      await enqueue(database, identity, input.operationId, 'sale.create', {
        sale,
        customer,
        items,
        payment,
        movements,
        allowNegativeStock: input.allowNegativeStock,
        ...(correction ? { correction, replacementPayments } : {}),
      });
      return sale;
    },
  );
}
async function reverseSale(
  database: LedgerDB,
  storeId: string,
  saleId: string,
  reason: string,
  occurredAt: string,
  expectedPaymentIds?: string[],
) {
  reason = z.string().trim().min(1, 'Enter a reason.').max(500).parse(reason);
  const sale = await database.sales.get(saleId);
  if (!sale || sale.storeId !== storeId || sale.status !== 'active')
    throw new Error('This sale is no longer active. Open its receipt to review it.');
  const payments = activePayments(
    saleId,
    await database.payments.where('saleId').equals(saleId).toArray(),
  );
  if (
    expectedPaymentIds &&
    [...expectedPaymentIds].sort().join() !==
      payments
        .map((p) => p.id)
        .sort()
        .join()
  )
    throw new Error(
      'Payments changed while you were preparing this correction. Discard this draft and reopen the sale to review the latest payments.',
    );
  const reversals = payments.map((p) => ({
    ...p,
    id: crypto.randomUUID(),
    reversalOf: p.id,
    createdAt: occurredAt,
    receivedAt: occurredAt,
  }));
  const items = await database.saleItems.where('saleId').equals(saleId).toArray();
  const movements = [];
  for (const item of items) {
    if (!item.productUnitId) continue;
    const unit = await database.productUnits.get(item.productUnitId);
    if (!unit || unit.storeId !== storeId)
      throw new Error('The original stock item is unavailable.');
    await database.productUnits.update(unit.id, {
      quantityOnHand: milliToDecimal(
        decimalToMilli(unit.quantityOnHand) + decimalToMilli(item.quantity),
      ),
      updatedAt: occurredAt,
    });
    movements.push({
      id: crypto.randomUUID(),
      storeId,
      productUnitId: unit.id,
      saleItemId: item.id,
      quantityDelta: item.quantity,
      reason: 'reversal' as const,
      occurredAt,
      createdAt: occurredAt,
    });
  }
  await database.sales.update(saleId, {
    status: 'voided',
    voidReason: reason,
    voidedAt: occurredAt,
  });
  await database.payments.bulkAdd(reversals);
  await database.stockMovements.bulkAdd(movements);
  return {
    saleId,
    reason,
    occurredAt,
    expectedPaymentIds: payments.map((p) => p.id),
    reversals,
    movements,
  };
}

export async function voidSale(
  saleId: string,
  reason: string,
  expectedPaymentIds: string[],
  operationId: string,
  database: LedgerDB = db,
) {
  z.uuid().parse(operationId);
  reason = z.string().trim().min(1, 'Enter a reason.').max(500).parse(reason);
  const identity = await getIdentity(database);
  return database.transaction('rw', database.tables, async () => {
    await assertCanWrite(database);
    if (
      await isReplay(
        database,
        identity,
        operationId,
        'sale.void',
        (p) =>
          p.saleId === saleId &&
          p.reason === reason &&
          [...p.expectedPaymentIds].sort().join() === [...expectedPaymentIds].sort().join(),
      )
    )
      return;
    const payload = await reverseSale(
      database,
      identity.storeId,
      saleId,
      reason,
      new Date().toISOString(),
      expectedPaymentIds,
    );
    await enqueue(database, identity, operationId, 'sale.void', payload);
  });
}

export async function recordCustomerPayment(
  customerId: string,
  allocations: { saleId: string; amountKobo: number }[],
  operationId: string,
  database: LedgerDB = db,
) {
  z.uuid().parse(operationId);
  if (
    !allocations.length ||
    allocations.length > 100 ||
    new Set(allocations.map((p) => p.saleId)).size !== allocations.length
  )
    throw new Error('Select between one and 100 different sales.');
  allocations.forEach((p) =>
    koboSchema.positive('Enter an amount greater than zero.').parse(p.amountKobo),
  );
  sumKobo(allocations.map((p) => p.amountKobo));
  const identity = await getIdentity(database);
  return database.transaction(
    'rw',
    [database.sales, database.payments, database.outbox, database.metadata],
    async () => {
      await assertCanWrite(database);
      if (
        await isReplay(
          database,
          identity,
          operationId,
          'payment.allocate',
          (p) =>
            p.customerId === customerId &&
            p.payments.length === allocations.length &&
            p.payments.every(
              (payment, i) =>
                payment.saleId === allocations[i].saleId &&
                payment.amountKobo === allocations[i].amountKobo,
            ),
        )
      )
        return;
      const now = new Date().toISOString();
      const payments = [];
      for (const allocation of allocations) {
        const sale = await database.sales.get(allocation.saleId);
        if (
          !sale ||
          sale.storeId !== identity.storeId ||
          sale.customerId !== customerId ||
          sale.status !== 'active'
        )
          throw new Error('A selected sale is no longer available. Review the customer’s balance.');
        const previous = await database.payments.where('saleId').equals(sale.id).toArray();
        if (allocation.amountKobo > outstandingFor(sale, previous))
          throw new Error('A balance changed. Review the payment allocation before saving.');
        payments.push({
          id: crypto.randomUUID(),
          storeId: identity.storeId,
          ...allocation,
          receivedAt: now,
          createdAt: now,
          reversalOf: null,
        });
      }
      await database.payments.bulkAdd(payments);
      await enqueue(database, identity, operationId, 'payment.allocate', { customerId, payments });
    },
  );
}
export async function recordPayment(
  saleId: string,
  amountKobo: number,
  operationId: string,
  database: LedgerDB = db,
) {
  koboSchema.positive('Enter an amount greater than zero.').parse(amountKobo);
  z.uuid().parse(operationId);
  const identity = await getIdentity(database);
  return database.transaction(
    'rw',
    [database.sales, database.payments, database.outbox, database.metadata],
    async () => {
      await assertCanWrite(database);
      if (
        await isReplay(
          database,
          identity,
          operationId,
          'payment.create',
          (payment) => payment.saleId === saleId && payment.amountKobo === amountKobo,
        )
      )
        return;
      const sale = await database.sales.get(saleId);
      if (!sale || sale.storeId !== identity.storeId || sale.status !== 'active')
        throw new Error('This sale is unavailable.');
      const payments = await database.payments.where('saleId').equals(saleId).toArray();
      if (amountKobo > outstandingFor(sale, payments))
        throw new Error('Payment cannot exceed the amount still owed.');
      const now = new Date().toISOString();
      const payment = {
        id: crypto.randomUUID(),
        storeId: identity.storeId,
        saleId,
        amountKobo,
        receivedAt: now,
        createdAt: now,
        reversalOf: null,
      };
      await database.payments.add(payment);
      await enqueue(database, identity, operationId, 'payment.create', payment);
    },
  );
}
export async function registerStock(
  name: string,
  label: string,
  quantity: string,
  priceKobo: number,
  operationId: string,
  database: LedgerDB = db,
) {
  name = nameSchema.parse(name);
  label = nameSchema.parse(label);
  koboSchema.parse(priceKobo);
  z.uuid().parse(operationId);
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(quantity))
    throw new Error('Enter a stock count of zero or more, with up to 3 decimal places.');
  const identity = await getIdentity(database);
  return database.transaction(
    'rw',
    [
      database.products,
      database.productUnits,
      database.stockMovements,
      database.outbox,
      database.metadata,
    ],
    async () => {
      await assertCanWrite(database);
      if (
        await isReplay(
          database,
          identity,
          operationId,
          'stock.register',
          ({ product, unit }) =>
            product.normalizedName === normalize(name) &&
            unit.label === label &&
            unit.suggestedUnitPriceKobo === priceKobo &&
            decimalToMilli(unit.quantityOnHand) === decimalToMilli(quantity),
        )
      )
        return;
      const now = new Date().toISOString();
      let product = await database.products
        .where('normalizedName')
        .equals(normalize(name))
        .and((p) => p.storeId === identity.storeId)
        .first();
      if (!product) {
        product = {
          id: crypto.randomUUID(),
          storeId: identity.storeId,
          name,
          normalizedName: normalize(name),
          active: true,
          createdAt: now,
          updatedAt: now,
        };
        await database.products.add(product);
      }
      const unit = {
        id: crypto.randomUUID(),
        storeId: identity.storeId,
        productId: product.id,
        label,
        normalizedLabel: normalize(label),
        suggestedUnitPriceKobo: priceKobo,
        quantityOnHand: milliToDecimal(decimalToMilli(quantity)),
        createdAt: now,
        updatedAt: now,
      };
      if (
        await database.productUnits
          .where('[productId+normalizedLabel]')
          .equals([product.id, unit.normalizedLabel])
          .first()
      )
        throw new Error('This product already has that unit. Adjust its existing stock count.');
      const movement = {
        id: crypto.randomUUID(),
        storeId: identity.storeId,
        productUnitId: unit.id,
        saleItemId: null,
        quantityDelta: unit.quantityOnHand,
        reason: 'initial_stock' as const,
        occurredAt: now,
        createdAt: now,
      };
      await database.productUnits.add(unit);
      await database.stockMovements.add(movement);
      await enqueue(database, identity, operationId, 'stock.register', { product, unit, movement });
    },
  );
}
export async function adjustStock(
  unitId: string,
  count: string,
  operationId: string,
  database: LedgerDB = db,
) {
  z.uuid().parse(operationId);
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(count))
    throw new Error('Enter a count of zero or more, with up to 3 decimal places.');
  const identity = await getIdentity(database);
  return database.transaction(
    'rw',
    [database.productUnits, database.stockMovements, database.outbox, database.metadata],
    async () => {
      await assertCanWrite(database);
      if (
        await isReplay(
          database,
          identity,
          operationId,
          'stock.adjust',
          (payload) =>
            payload.unitId === unitId && decimalToMilli(payload.count) === decimalToMilli(count),
        )
      )
        return;
      const unit = await database.productUnits.get(unitId);
      if (!unit || unit.storeId !== identity.storeId) throw new Error('Stock item not found.');
      const now = new Date().toISOString();
      const movement = {
        id: crypto.randomUUID(),
        storeId: identity.storeId,
        productUnitId: unitId,
        saleItemId: null,
        quantityDelta: milliToDecimal(decimalToMilli(count) - decimalToMilli(unit.quantityOnHand)),
        reason: 'manual_adjustment' as const,
        occurredAt: now,
        createdAt: now,
      };
      await database.productUnits.update(unitId, {
        quantityOnHand: milliToDecimal(decimalToMilli(count)),
        updatedAt: now,
      });
      await database.stockMovements.add(movement);
      await enqueue(database, identity, operationId, 'stock.adjust', { unitId, count, movement });
    },
  );
}
