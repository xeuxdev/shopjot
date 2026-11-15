import { eq } from 'drizzle-orm';
import { milliToDecimal, decimalToMilli, type LedgerSnapshot } from './domain/index';
import type { Database } from './db/client';
import * as s from './db/schema';

const quantity = (value: string) => milliToDecimal(decimalToMilli(value));
const scoped = (row: { id: string; storeId: string; createdAt: Date }) => ({
  id: row.id,
  storeId: row.storeId,
  createdAt: row.createdAt.toISOString(),
});
export const dto = {
  customers: (r: typeof s.customers.$inferSelect): LedgerSnapshot['customers'][number] => ({
    ...scoped(r),
    name: r.name,
    normalizedName: r.normalizedName,
    phone: r.phone,
    updatedAt: r.updatedAt.toISOString(),
  }),
  products: (r: typeof s.products.$inferSelect): LedgerSnapshot['products'][number] => ({
    ...scoped(r),
    name: r.name,
    normalizedName: r.normalizedName,
    active: r.active,
    updatedAt: r.updatedAt.toISOString(),
  }),
  units: (r: typeof s.productUnits.$inferSelect): LedgerSnapshot['units'][number] => ({
    ...scoped(r),
    productId: r.productId,
    label: r.label,
    normalizedLabel: r.normalizedLabel,
    suggestedUnitPriceKobo: Number(r.suggestedUnitPriceKobo),
    quantityOnHand: quantity(r.quantityOnHand),
    updatedAt: r.updatedAt.toISOString(),
  }),
  sales: (r: typeof s.sales.$inferSelect): LedgerSnapshot['sales'][number] => ({
    ...scoped(r),
    customerId: r.customerId,
    totalKobo: Number(r.totalKobo),
    occurredAt: r.occurredAt.toISOString(),
    status: r.status as 'active' | 'voided',
  }),
  items: (r: typeof s.saleItems.$inferSelect): LedgerSnapshot['items'][number] => ({
    ...scoped(r),
    saleId: r.saleId,
    position: r.position,
    productUnitId: r.productUnitId,
    name: r.nameSnapshot,
    quantity: quantity(r.quantityDecimal),
    quantityLabel: r.quantityLabelSnapshot,
    unitPriceKobo: Number(r.unitPriceKobo),
    lineTotalKobo: Number(r.lineTotalKobo),
  }),
  payments: (r: typeof s.payments.$inferSelect): LedgerSnapshot['payments'][number] => ({
    ...scoped(r),
    saleId: r.saleId,
    amountKobo: Number(r.amountKobo),
    receivedAt: r.receivedAt.toISOString(),
    reversalOf: r.reversalOf,
  }),
  movements: (r: typeof s.stockMovements.$inferSelect): LedgerSnapshot['movements'][number] => ({
    ...scoped(r),
    productUnitId: r.productUnitId,
    saleItemId: r.saleItemId,
    quantityDelta: quantity(r.quantityDeltaDecimal),
    reason: r.reason as LedgerSnapshot['movements'][number]['reason'],
    occurredAt: r.occurredAt.toISOString(),
  }),
};
export async function readSnapshot(
  reader: Pick<Database, 'select'>,
  storeId: string,
): Promise<LedgerSnapshot> {
  return {
    customers: (
      await reader.select().from(s.customers).where(eq(s.customers.storeId, storeId))
    ).map(dto.customers),
    products: (await reader.select().from(s.products).where(eq(s.products.storeId, storeId))).map(
      dto.products,
    ),
    units: (
      await reader.select().from(s.productUnits).where(eq(s.productUnits.storeId, storeId))
    ).map(dto.units),
    sales: (await reader.select().from(s.sales).where(eq(s.sales.storeId, storeId))).map(dto.sales),
    items: (await reader.select().from(s.saleItems).where(eq(s.saleItems.storeId, storeId))).map(
      dto.items,
    ),
    payments: (await reader.select().from(s.payments).where(eq(s.payments.storeId, storeId))).map(
      dto.payments,
    ),
    movements: (
      await reader.select().from(s.stockMovements).where(eq(s.stockMovements.storeId, storeId))
    ).map(dto.movements),
  };
}
