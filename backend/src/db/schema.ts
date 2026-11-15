import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigint,
  numeric,
  integer,
  unique,
  uniqueIndex,
  index,
  check,
  foreignKey,
  bigserial,
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey(),
    email: text().notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);
export const stores = pgTable('stores', {
  id: uuid().primaryKey(),
  ownerUserId: uuid('owner_user_id')
    .references(() => users.id)
    .notNull(),
  name: text().notNull(),
  timezone: text().default('Africa/Lagos').notNull(),
  primaryDeviceId: uuid('primary_device_id'),
  createdAt: createdAt(),
});
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    deviceId: uuid('device_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
);
const scope = () => ({
  id: uuid().primaryKey(),
  storeId: uuid('store_id')
    .references(() => stores.id)
    .notNull(),
  createdAt: createdAt(),
});
export const customers = pgTable(
  'customers',
  {
    ...scope(),
    name: text().notNull(),
    normalizedName: text('normalized_name').notNull(),
    phone: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customers_store_id_unique').on(t.storeId, t.id),
    index('customers_name_idx').on(t.storeId, t.normalizedName),
  ],
);
export const products = pgTable(
  'products',
  {
    ...scope(),
    name: text().notNull(),
    normalizedName: text('normalized_name').notNull(),
    active: boolean().default(true).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('products_store_id_unique').on(t.storeId, t.id),
    index('products_name_idx').on(t.storeId, t.normalizedName),
  ],
);
export const productUnits = pgTable(
  'product_units',
  {
    ...scope(),
    productId: uuid('product_id').notNull(),
    label: text().notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    suggestedUnitPriceKobo: bigint('suggested_unit_price_kobo', { mode: 'bigint' }).notNull(),
    quantityOnHand: numeric('quantity_on_hand', { precision: 16, scale: 3 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('units_store_id_unique').on(t.storeId, t.id),
    uniqueIndex('units_product_label_unique').on(t.productId, t.normalizedLabel),
    foreignKey({
      columns: [t.storeId, t.productId],
      foreignColumns: [products.storeId, products.id],
    }),
    check('unit_price_valid', sql`${t.suggestedUnitPriceKobo} between 0 and 9007199254740991`),
  ],
);
export const sales = pgTable(
  'sales',
  {
    ...scope(),
    customerId: uuid('customer_id').notNull(),
    totalKobo: bigint('total_kobo', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    status: text().default('active').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sales_store_id_unique').on(t.storeId, t.id),
    index('sales_occurred_idx').on(t.storeId, t.occurredAt),
    index('sales_customer_idx').on(t.storeId, t.customerId),
    foreignKey({
      columns: [t.storeId, t.customerId],
      foreignColumns: [customers.storeId, customers.id],
    }),
    check('sale_total_valid', sql`${t.totalKobo} between 0 and 9007199254740991`),
    check('sale_status_valid', sql`${t.status} in ('active', 'voided')`),
  ],
);
export const saleItems = pgTable(
  'sale_items',
  {
    ...scope(),
    saleId: uuid('sale_id').notNull(),
    position: integer('position').default(0).notNull(),
    productUnitId: uuid('product_unit_id'),
    nameSnapshot: text('name_snapshot').notNull(),
    quantityDecimal: numeric('quantity_decimal', { precision: 16, scale: 3 }).notNull(),
    quantityLabelSnapshot: text('quantity_label_snapshot').notNull(),
    unitPriceKobo: bigint('unit_price_kobo', { mode: 'bigint' }).notNull(),
    lineTotalKobo: bigint('line_total_kobo', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    unique('items_store_id_unique').on(t.storeId, t.id),
    index('items_sale_idx').on(t.storeId, t.saleId),
    foreignKey({ columns: [t.storeId, t.saleId], foreignColumns: [sales.storeId, sales.id] }),
    foreignKey({
      columns: [t.storeId, t.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.id],
    }),
    check('item_quantity_positive', sql`${t.quantityDecimal} > 0`),
    check('item_position_nonnegative', sql`${t.position} >= 0`),
    check('item_price_valid', sql`${t.unitPriceKobo} between 0 and 9007199254740991`),
    check('item_total_valid', sql`${t.lineTotalKobo} between 0 and 9007199254740991`),
  ],
);
export const payments = pgTable(
  'payments',
  {
    ...scope(),
    saleId: uuid('sale_id').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'bigint' }).notNull(),
    method: text(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    reversalOf: uuid('reversal_of'),
  },
  (t) => [
    unique('payments_store_id_unique').on(t.storeId, t.id),
    uniqueIndex('payment_reversal_unique').on(t.reversalOf),
    index('payments_sale_idx').on(t.storeId, t.saleId),
    index('payments_received_idx').on(t.storeId, t.receivedAt),
    foreignKey({ columns: [t.storeId, t.saleId], foreignColumns: [sales.storeId, sales.id] }),
    foreignKey({ columns: [t.storeId, t.reversalOf], foreignColumns: [t.storeId, t.id] }),
    check('payment_amount_valid', sql`${t.amountKobo} between 1 and 9007199254740991`),
  ],
);
export const stockMovements = pgTable(
  'stock_movements',
  {
    ...scope(),
    productUnitId: uuid('product_unit_id').notNull(),
    saleItemId: uuid('sale_item_id'),
    quantityDeltaDecimal: numeric('quantity_delta_decimal', { precision: 16, scale: 3 }).notNull(),
    reason: text().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('movements_unit_idx').on(t.storeId, t.productUnitId),
    foreignKey({
      columns: [t.storeId, t.productUnitId],
      foreignColumns: [productUnits.storeId, productUnits.id],
    }),
    foreignKey({
      columns: [t.storeId, t.saleItemId],
      foreignColumns: [saleItems.storeId, saleItems.id],
    }),
    check(
      'movement_reason_valid',
      sql`${t.reason} in ('initial_stock', 'sale', 'manual_adjustment', 'reversal')`,
    ),
  ],
);
export const processedSyncOperations = pgTable(
  'processed_sync_operations',
  {
    storeId: uuid('store_id')
      .references(() => stores.id)
      .notNull(),
    operationId: uuid('operation_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    operationType: text('operation_type').notNull(),
    result: jsonb().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.operationId] })],
);
export const syncChanges = pgTable(
  'sync_changes',
  {
    changeId: bigserial('change_id', { mode: 'bigint' }).primaryKey(),
    storeId: uuid('store_id')
      .references(() => stores.id)
      .notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    operation: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('changes_store_cursor_idx').on(t.storeId, t.changeId)],
);
