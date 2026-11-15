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
  type SaleInput,
} from '../domain/index';
import { db, getIdentity, type LedgerDB } from './database';
import { assertCanWrite, enqueue } from './queue';

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
      const existingSale = await database.sales.get(input.id);
      if (existingSale) return existingSale;
      const createdAt = new Date().toISOString();
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
      };
      await database.sales.add(sale);
      await database.saleItems.bulkAdd(items);
      const payment =
        input.initialPaymentKobo > 0
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
      await enqueue(database, identity, input.operationId, 'sale.create', {
        sale,
        customer,
        items,
        payment,
        movements,
        allowNegativeStock: input.allowNegativeStock,
      });
      return sale;
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
      if (await database.outbox.get(operationId)) return;
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
      if (await database.outbox.get(operationId)) return;
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
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(count))
    throw new Error('Enter a count of zero or more, with up to 3 decimal places.');
  const identity = await getIdentity(database);
  return database.transaction(
    'rw',
    [database.productUnits, database.stockMovements, database.outbox, database.metadata],
    async () => {
      await assertCanWrite(database);
      if (await database.outbox.get(operationId)) return;
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
