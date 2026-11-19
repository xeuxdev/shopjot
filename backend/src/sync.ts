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
  activePayments,
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
  audited = false,
) {
  requireRule(
    audited || payment.reversalOf === null,
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
type VoidPayload = Extract<SyncOperation, { kind: 'sale.void' }>['payload'];
async function reverseSale(tx: Transaction, storeId: string, payload: VoidPayload) {
  const [sale] = await tx
    .select()
    .from(s.sales)
    .where(and(eq(s.sales.id, payload.saleId), eq(s.sales.storeId, storeId)));
  requireRule(sale?.status === 'active', 'This sale is no longer active. Review its receipt.');
  const payments = activePayments(
    sale.id,
    (
      await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.saleId, sale.id), eq(s.payments.storeId, storeId)))
    ).map(dto.payments),
  );
  requireRule(
    [...payload.expectedPaymentIds].sort().join() ===
      payments
        .map((p) => p.id)
        .sort()
        .join(),
    'Payments changed on another phone. Keep an export and review this correction before retrying.',
  );
  requireRule(
    payload.reversals.length === payments.length &&
      new Set(payload.reversals.map((p) => p.reversalOf)).size === payments.length,
    'Every original payment needs exactly one reversal.',
  );
  for (const payment of payments) {
    const reversal = payload.reversals.find((p) => p.reversalOf === payment.id);
    requireRule(
      reversal &&
        reversal.saleId === sale.id &&
        reversal.amountKobo === payment.amountKobo &&
        reversal.receivedAt === payload.occurredAt &&
        reversal.createdAt === payload.occurredAt,
      'Invalid payment reversal.',
    );
    await insertPayment(tx, reversal, true);
  }
  const items = (
    await tx
      .select()
      .from(s.saleItems)
      .where(and(eq(s.saleItems.saleId, sale.id), eq(s.saleItems.storeId, storeId)))
  )
    .map(dto.items)
    .filter((i) => i.productUnitId);
  requireRule(
    payload.movements.length === items.length &&
      new Set(payload.movements.map((m) => m.saleItemId)).size === items.length,
    'Every linked original item needs exactly one stock reversal.',
  );
  for (const item of items) {
    const movement = payload.movements.find((m) => m.saleItemId === item.id);
    requireRule(
      movement &&
        movement.reason === 'reversal' &&
        movement.productUnitId === item.productUnitId &&
        movement.occurredAt === payload.occurredAt &&
        decimalToMilli(movement.quantityDelta) === decimalToMilli(item.quantity),
      'Invalid stock reversal.',
    );
    const unit = await getUnit(tx, storeId, item.productUnitId!);
    const [updated] = await tx
      .update(s.productUnits)
      .set({
        quantityOnHand: milliToDecimal(
          decimalToMilli(unit.quantityOnHand) + decimalToMilli(item.quantity),
        ),
        updatedAt: new Date(payload.occurredAt),
      })
      .where(eq(s.productUnits.id, unit.id))
      .returning();
    await emit(tx, { entity: 'units', record: dto.units(updated) });
    await insertMovement(tx, movement);
  }
  const [updated] = await tx
    .update(s.sales)
    .set({
      status: 'voided',
      voidReason: payload.reason,
      voidedAt: new Date(payload.occurredAt),
      updatedAt: new Date(payload.occurredAt),
    })
    .where(eq(s.sales.id, sale.id))
    .returning();
  await emit(tx, { entity: 'sales', record: dto.sales(updated) });
  return {
    sale,
    payments: payments.sort(
      (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
    ),
  };
}
async function applyPayment(
  tx: Transaction,
  storeId: string,
  payment: Extract<SyncChange, { entity: 'payments' }>['record'],
  customerId?: string,
) {
  const [sale] = await tx
    .select()
    .from(s.sales)
    .where(and(eq(s.sales.id, payment.saleId), eq(s.sales.storeId, storeId)));
  requireRule(
    sale && sale.status === 'active' && (!customerId || sale.customerId === customerId),
    'This repayment does not reference an active sale for this customer in this store.',
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
    const { sale, customer, items, payment, movements } = op.payload;
    requireRule(
      !sale.voidReason && !sale.voidedAt && sale.replacesSaleId === op.payload.correction?.saleId,
      'A replacement sale must reference its audited correction.',
    );
    const original = op.payload.correction
      ? await reverseSale(tx, storeId, op.payload.correction)
      : undefined;
    requireRule(
      !original ||
        (original.sale.occurredAt.toISOString() === sale.occurredAt &&
          original.sale.id !== sale.id),
      'A correction must preserve the original sale date and use a new receipt ID.',
    );
    requireRule(
      original ? !payment && !!op.payload.replacementPayments : !op.payload.replacementPayments,
      'Invalid correction payment history.',
    );
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
    if (original) {
      const replacements = op.payload.replacementPayments!;
      let remaining = sumKobo(replacements.map((p) => p.amountKobo));
      requireRule(remaining <= total, 'Corrected payments cannot exceed the sale total.');
      const expected: { amountKobo: number; receivedAt: string }[] = [];
      for (const previous of original.payments) {
        const amountKobo = Math.min(remaining, previous.amountKobo);
        if (amountKobo) expected.push({ amountKobo, receivedAt: previous.receivedAt });
        remaining -= amountKobo;
      }
      if (remaining)
        expected.push({ amountKobo: remaining, receivedAt: op.payload.correction!.occurredAt });
      requireRule(
        replacements.length === expected.length &&
          replacements.every(
            (p, i) =>
              p.saleId === sale.id &&
              !p.reversalOf &&
              p.amountKobo === expected[i].amountKobo &&
              p.receivedAt === expected[i].receivedAt,
          ),
        'Corrected payments must preserve their original collection dates.',
      );
    }
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
      voidedAt: null,
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
      // Other phones may have sold against the same offline stock count. Keep
      // every real sale and its exact movement; a shortage remains visible as
      // negative stock instead of leaving a paid sale stranded on its phone.
      const [updated] = await tx
        .update(s.productUnits)
        .set({ quantityOnHand: milliToDecimal(remaining), updatedAt: new Date(sale.createdAt) })
        .where(eq(s.productUnits.id, unit.id))
        .returning();
      await emit(tx, { entity: 'units', record: dto.units(updated) });
      await insertMovement(tx, movement);
    }
    if (payment) await insertPayment(tx, payment);
    for (const replacement of op.payload.replacementPayments ?? [])
      await insertPayment(tx, replacement);
  } else if (op.kind === 'payment.create') {
    await applyPayment(tx, storeId, op.payload);
  } else if (op.kind === 'payment.allocate') {
    const { customerId, payments } = op.payload;
    requireRule(
      new Set(payments.map((p) => p.saleId)).size === payments.length,
      'Select each sale only once.',
    );
    sumKobo(payments.map((p) => p.amountKobo));
    for (const payment of payments) await applyPayment(tx, storeId, payment, customerId);
  } else if (op.kind === 'sale.void') {
    await reverseSale(tx, storeId, op.payload);
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
    await tx
      .select({ id: s.stores.id })
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
