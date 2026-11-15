import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  canonicalJson,
  changeSchema,
  decimalToMilli,
  entityNames,
  lineTotal,
  milliToDecimal,
  normalize,
  outstandingFor,
  snapshotJson,
  sumKobo,
  type SyncChange,
  type SyncOperation,
} from './domain/index';
import type { Database, Transaction } from './db/client';
import type { AuthAccount } from './auth';
import { ApiError, requireRule } from './errors';
import { dto, readSnapshot } from './records';
import * as s from './db/schema';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const dates = (r: { createdAt: string; updatedAt: string }) => ({
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});
async function emit(tx: Transaction, change: SyncChange) {
  await tx.insert(s.syncChanges).values({
    storeId: change.record.storeId,
    entityType: change.entity,
    entityId: change.record.id,
    operation: 'upsert',
    payload: changeSchema.parse(change),
  });
}
async function getUnit(tx: Transaction, storeId: string, id: string) {
  const [unit] = await tx
    .select()
    .from(s.productUnits)
    .where(and(eq(s.productUnits.id, id), eq(s.productUnits.storeId, storeId)));
  requireRule(unit, 'The linked stock unit does not belong to this store.');
  return unit;
}
async function insertMovement(
  tx: Transaction,
  movement: Extract<SyncChange, { entity: 'movements' }>['record'],
) {
  await tx.insert(s.stockMovements).values({
    id: movement.id,
    storeId: movement.storeId,
    productUnitId: movement.productUnitId,
    saleItemId: movement.saleItemId,
    quantityDeltaDecimal: movement.quantityDelta,
    reason: movement.reason,
    occurredAt: new Date(movement.occurredAt),
    createdAt: new Date(movement.createdAt),
  });
  await emit(tx, { entity: 'movements', record: movement });
}
async function insertPayment(
  tx: Transaction,
  payment: Extract<SyncChange, { entity: 'payments' }>['record'],
) {
  requireRule(
    payment.reversalOf === null,
    'Use the audited correction flow for payment reversals.',
  );
  await tx.insert(s.payments).values({
    ...payment,
    amountKobo: BigInt(payment.amountKobo),
    receivedAt: new Date(payment.receivedAt),
    createdAt: new Date(payment.createdAt),
  });
  await emit(tx, { entity: 'payments', record: payment });
}
function scopedPayload(value: unknown, storeId: string): void {
  if (!value || typeof value !== 'object') return;
  if ('storeId' in value)
    requireRule(value.storeId === storeId, 'Every record must belong to the signed-in store.');
  for (const child of Object.values(value)) scopedPayload(child, storeId);
}
async function applyOperation(tx: Transaction, op: SyncOperation) {
  const storeId = op.storeId;
  scopedPayload(op.payload, storeId);
  if (op.kind === 'stock.register') {
    const { product, unit, movement } = op.payload;
    requireRule(
      product.normalizedName === normalize(product.name) &&
        unit.normalizedLabel === normalize(unit.label),
      'Product and unit search names must match their display names.',
    );
    requireRule(
      unit.productId === product.id &&
        movement.productUnitId === unit.id &&
        movement.reason === 'initial_stock' &&
        !movement.saleItemId,
      'Invalid initial stock association.',
    );
    requireRule(
      decimalToMilli(unit.quantityOnHand) >= 0n &&
        decimalToMilli(unit.quantityOnHand) === decimalToMilli(movement.quantityDelta),
      'Initial stock must match its movement.',
    );
    const [existing] = await tx.select().from(s.products).where(eq(s.products.id, product.id));
    if (existing)
      requireRule(
        canonicalJson(dto.products(existing)) === canonicalJson(product),
        'The product conflicts with an existing record.',
      );
    else {
      await tx.insert(s.products).values({ ...product, ...dates(product) });
      await emit(tx, { entity: 'products', record: product });
    }
    await tx.insert(s.productUnits).values({
      ...unit,
      ...dates(unit),
      suggestedUnitPriceKobo: BigInt(unit.suggestedUnitPriceKobo),
    });
    await emit(tx, { entity: 'units', record: unit });
    await insertMovement(tx, movement);
  } else if (op.kind === 'sale.create') {
    const { sale, customer, items, payment, movements, allowNegativeStock } = op.payload;
    requireRule(
      sale.status === 'active' && sale.customerId === customer.id,
      'A new sale must have an active customer association.',
    );
    requireRule(
      customer.normalizedName === normalize(customer.name),
      'Customer search name must match their name.',
    );
    const [existing] = await tx.select().from(s.customers).where(eq(s.customers.id, customer.id));
    if (existing)
      requireRule(
        canonicalJson(dto.customers(existing)) === canonicalJson(customer),
        'The customer conflicts with an existing record.',
      );
    else {
      await tx.insert(s.customers).values({ ...customer, ...dates(customer) });
      await emit(tx, { entity: 'customers', record: customer });
    }
    requireRule(
      new Set(items.map((i) => i.id)).size === items.length &&
        new Set(items.map((i) => i.position)).size === items.length,
      'Sale items must have unique IDs and positions.',
    );
    const total = sumKobo(
      items.map((item) => {
        requireRule(
          item.saleId === sale.id &&
            item.lineTotalKobo === lineTotal(item.quantity, item.unitPriceKobo),
          'A sale item has an invalid association or total.',
        );
        return item.lineTotalKobo;
      }),
    );
    requireRule(sale.totalKobo === total, 'Sale total does not match the goods.');
    if (payment)
      requireRule(
        payment.saleId === sale.id &&
          payment.amountKobo <= total &&
          payment.receivedAt === sale.occurredAt,
        'Invalid initial payment.',
      );
    requireRule(
      movements.length === items.filter((i) => i.productUnitId).length &&
        new Set(movements.map((m) => m.saleItemId)).size === movements.length,
      'Every linked sale item needs exactly one stock movement.',
    );
    await tx.insert(s.sales).values({
      ...sale,
      totalKobo: BigInt(total),
      occurredAt: new Date(sale.occurredAt),
      createdAt: new Date(sale.createdAt),
      updatedAt: new Date(sale.createdAt),
    });
    await emit(tx, { entity: 'sales', record: sale });
    for (const item of items) {
      await tx.insert(s.saleItems).values({
        id: item.id,
        storeId,
        saleId: sale.id,
        position: item.position,
        productUnitId: item.productUnitId,
        nameSnapshot: item.name,
        quantityDecimal: item.quantity,
        quantityLabelSnapshot: item.quantityLabel,
        unitPriceKobo: BigInt(item.unitPriceKobo),
        lineTotalKobo: BigInt(item.lineTotalKobo),
        createdAt: new Date(item.createdAt),
      });
      await emit(tx, { entity: 'items', record: item });
      if (!item.productUnitId) continue;
      const unit = await getUnit(tx, storeId, item.productUnitId);
      requireRule(
        unit.normalizedLabel === normalize(item.quantityLabel),
        'The linked stock unit has an incompatible quantity label.',
      );
      const movement = movements.find((m) => m.saleItemId === item.id);
      requireRule(
        movement &&
          movement.productUnitId === unit.id &&
          movement.reason === 'sale' &&
          movement.occurredAt === sale.occurredAt &&
          decimalToMilli(movement.quantityDelta) === -decimalToMilli(item.quantity),
        'Invalid sale stock movement.',
      );
      const remaining = decimalToMilli(unit.quantityOnHand) - decimalToMilli(item.quantity);
      requireRule(
        remaining >= 0n || allowNegativeStock,
        'The sale exceeds stock without an explicit shortage override.',
      );
      const [updated] = await tx
        .update(s.productUnits)
        .set({ quantityOnHand: milliToDecimal(remaining), updatedAt: new Date(sale.createdAt) })
        .where(eq(s.productUnits.id, unit.id))
        .returning();
      await emit(tx, { entity: 'units', record: dto.units(updated) });
      await insertMovement(tx, movement);
    }
    if (payment) await insertPayment(tx, payment);
  } else if (op.kind === 'payment.create') {
    const payment = op.payload;
    const [sale] = await tx
      .select()
      .from(s.sales)
      .where(and(eq(s.sales.id, payment.saleId), eq(s.sales.storeId, storeId)));
    requireRule(
      sale && sale.status === 'active',
      'This repayment does not reference an active sale in this store.',
    );
    const payments = await tx
      .select()
      .from(s.payments)
      .where(and(eq(s.payments.saleId, sale.id), eq(s.payments.storeId, storeId)));
    requireRule(
      payment.amountKobo <= outstandingFor(dto.sales(sale), payments.map(dto.payments)),
      'Payment exceeds the outstanding balance.',
    );
    await insertPayment(tx, payment);
  } else {
    const { unitId, count, movement } = op.payload;
    const unit = await getUnit(tx, storeId, unitId);
    requireRule(
      movement.productUnitId === unitId &&
        movement.reason === 'manual_adjustment' &&
        !movement.saleItemId &&
        decimalToMilli(movement.quantityDelta) ===
          decimalToMilli(count) - decimalToMilli(unit.quantityOnHand),
      'The count adjustment does not match the stock history.',
    );
    const [updated] = await tx
      .update(s.productUnits)
      .set({ quantityOnHand: count, updatedAt: new Date(movement.createdAt) })
      .where(eq(s.productUnits.id, unitId))
      .returning();
    await emit(tx, { entity: 'units', record: dto.units(updated) });
    await insertMovement(tx, movement);
  }
}
export async function pushOperation(db: Database, account: AuthAccount, operation: SyncOperation) {
  if (operation.storeId !== account.storeId || operation.deviceId !== account.deviceId)
    throw new ApiError(
      403,
      'STORE_MISMATCH',
      'This operation does not belong to your signed-in store and device.',
    );
  return db.transaction(async (tx) => {
    // This also orders per-store change cursors by commit, avoiding skipped uncommitted IDs.
    const [store] = await tx
      .select()
      .from(s.stores)
      .where(eq(s.stores.id, account.storeId))
      .for('update');
    const [previous] = await tx
      .select()
      .from(s.processedSyncOperations)
      .where(
        and(
          eq(s.processedSyncOperations.storeId, account.storeId),
          eq(s.processedSyncOperations.operationId, operation.operationId),
        ),
      );
    const operationDigest = digest(canonicalJson(operation));
    if (previous) {
      const result = previous.result as { digest: string };
      if (result.digest !== operationDigest)
        throw new ApiError(
          409,
          'OPERATION_ID_REUSED',
          'This operation ID was already used with different contents.',
        );
      return previous.result;
    }
    if (store.primaryDeviceId !== operation.deviceId)
      throw new ApiError(
        409,
        'DEVICE_REPLACED',
        'Another phone is now the primary editor. Keep this phone’s unbacked records and review them before switching devices.',
      );
    await applyOperation(tx, operation);
    const result = {
      operationId: operation.operationId,
      storeId: account.storeId,
      digest: operationDigest,
      acknowledgedAt: new Date().toISOString(),
    };
    await tx.insert(s.processedSyncOperations).values({
      storeId: account.storeId,
      operationId: operation.operationId,
      deviceId: operation.deviceId,
      operationType: operation.kind,
      result,
    });
    return result;
  });
}
export async function pullChanges(db: Database, storeId: string, cursor: string) {
  const rows = await db
    .select()
    .from(s.syncChanges)
    .where(and(eq(s.syncChanges.storeId, storeId), gt(s.syncChanges.changeId, BigInt(cursor))))
    .orderBy(asc(s.syncChanges.changeId))
    .limit(251);
  const page = rows.slice(0, 250);
  return {
    changes: page.map((r) => changeSchema.parse(r.payload)),
    nextCursor: page.at(-1)?.changeId.toString() ?? cursor,
    hasMore: rows.length > 250,
  };
}
export async function manifest(db: Database, storeId: string) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: s.stores.id })
      .from(s.stores)
      .where(eq(s.stores.id, storeId))
      .for('share');
    const snapshot = await readSnapshot(tx, storeId);
    const [row] = await tx
      .select({ cursor: sql<string>`coalesce(max(${s.syncChanges.changeId}),0)::text` })
      .from(s.syncChanges)
      .where(eq(s.syncChanges.storeId, storeId));
    return {
      cursor: row.cursor,
      digest: digest(snapshotJson(snapshot)),
      counts: Object.fromEntries(entityNames.map((key) => [key, snapshot[key].length])),
    };
  });
}
