import { z } from 'zod';
import { decimalToMilli, milliToDecimal } from './index';

const id = z.uuid();
const time = z.iso.datetime();
const name = z.string().trim().min(1).max(160);
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^-?\d{1,13}(\.\d{1,3})?$/);
const positiveQuantity = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/)
  .pipe(z.string().refine((v) => decimalToMilli(v) > 0n));
const scoped = { id, storeId: id, createdAt: time };
export const customerRecord = z.object({
  ...scoped,
  name,
  normalizedName: name,
  phone: z.string().max(40).nullable(),
  updatedAt: time,
});
export const productRecord = z.object({
  ...scoped,
  name,
  normalizedName: name,
  active: z.boolean(),
  updatedAt: time,
});
export const unitRecord = z.object({
  ...scoped,
  productId: id,
  label: name,
  normalizedLabel: name,
  suggestedUnitPriceKobo: money,
  quantityOnHand: decimal,
  updatedAt: time,
});
export const saleRecord = z.object({
  ...scoped,
  customerId: id,
  totalKobo: money,
  occurredAt: time,
  status: z.enum(['active', 'voided']),
  voidedAt: time.optional(),
  voidReason: z.string().trim().min(1).max(500).optional(),
  replacesSaleId: id.optional(),
});
export const itemRecord = z.object({
  ...scoped,
  saleId: id,
  position: z.number().int().min(0).max(99),
  name,
  quantity: positiveQuantity,
  quantityLabel: name,
  unitPriceKobo: money,
  lineTotalKobo: money,
  productUnitId: id.nullable(),
});
export const paymentRecord = z.object({
  ...scoped,
  saleId: id,
  amountKobo: money.positive(),
  receivedAt: time,
  reversalOf: id.nullable(),
});
export const movementRecord = z.object({
  ...scoped,
  productUnitId: id,
  saleItemId: id.nullable(),
  quantityDelta: decimal,
  reason: z.enum(['initial_stock', 'sale', 'manual_adjustment', 'reversal']),
  occurredAt: time,
});
const envelope = { version: z.literal(1), operationId: id, storeId: id, deviceId: id };
export const voidPayloadSchema = z.object({
  saleId: id,
  reason: z.string().trim().min(1).max(500),
  occurredAt: time,
  expectedPaymentIds: z.array(id),
  reversals: z.array(paymentRecord),
  movements: z.array(movementRecord).max(100),
});
export const syncOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...envelope,
    kind: z.literal('sale.create'),
    payload: z.object({
      sale: saleRecord,
      customer: customerRecord,
      items: z.array(itemRecord).min(1).max(100),
      payment: paymentRecord.nullable(),
      movements: z.array(movementRecord).max(100),
      allowNegativeStock: z.boolean(),
      correction: voidPayloadSchema.optional(),
      replacementPayments: z.array(paymentRecord).optional(),
    }),
  }),
  z.object({ ...envelope, kind: z.literal('payment.create'), payload: paymentRecord }),
  z.object({ ...envelope, kind: z.literal('sale.void'), payload: voidPayloadSchema }),
  z.object({
    ...envelope,
    kind: z.literal('payment.allocate'),
    payload: z.object({
      customerId: id,
      payments: z.array(paymentRecord).min(1).max(100),
    }),
  }),
  z.object({
    ...envelope,
    kind: z.literal('stock.register'),
    payload: z.object({ product: productRecord, unit: unitRecord, movement: movementRecord }),
  }),
  z.object({
    ...envelope,
    kind: z.literal('stock.adjust'),
    payload: z.object({
      unitId: id,
      count: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/),
      movement: movementRecord,
    }),
  }),
]);
export type SyncOperation = z.infer<typeof syncOperationSchema>;
export const entityNames = [
  'customers',
  'products',
  'units',
  'sales',
  'items',
  'payments',
  'movements',
] as const;
export const changeSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('customers'), record: customerRecord }),
  z.object({ entity: z.literal('products'), record: productRecord }),
  z.object({ entity: z.literal('units'), record: unitRecord }),
  z.object({ entity: z.literal('sales'), record: saleRecord }),
  z.object({ entity: z.literal('items'), record: itemRecord }),
  z.object({ entity: z.literal('payments'), record: paymentRecord }),
  z.object({ entity: z.literal('movements'), record: movementRecord }),
]);
export type SyncChange = z.infer<typeof changeSchema>;
export type LedgerSnapshot = {
  [K in SyncChange['entity']]: Extract<SyncChange, { entity: K }>['record'][];
};
export const cursorSchema = z
  .string()
  .regex(/^\d{1,19}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export const acknowledgmentSchema = z.object({
  operationId: id,
  storeId: id,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgedAt: time,
});
export const pullResponseSchema = z.object({
  changes: z.array(changeSchema).max(250),
  nextCursor: cursorSchema,
  hasMore: z.boolean(),
});
export const manifestSchema = z.object({
  cursor: cursorSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({
    customers: z.number().int().nonnegative(),
    products: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
    sales: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
    payments: z.number().int().nonnegative(),
    movements: z.number().int().nonnegative(),
  }),
});
export const accountResponseSchema = z.object({
  userId: id,
  email: z.email(),
  storeId: id,
  storeName: name,
  deviceId: id,
  writer: z.boolean(),
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;
export const credentialsSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  password: z.string().min(12, 'Use at least 12 characters for your password.').max(128),
  deviceId: id,
  expectedStoreId: id.optional(),
});
export const registrationSchema = credentialsSchema.extend({ storeId: id, storeName: name });

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function snapshotJson(snapshot: LedgerSnapshot): string {
  const normalized = Object.fromEntries(
    entityNames.map((entity) => [
      entity,
      snapshot[entity]
        .map((record) => {
          const result = { ...record } as Record<string, unknown>;
          for (const key of ['quantity', 'quantityOnHand', 'quantityDelta'])
            if (typeof result[key] === 'string')
              result[key] = milliToDecimal(decimalToMilli(result[key]));
          return result;
        })
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ]),
  );
  return canonicalJson(normalized);
}
