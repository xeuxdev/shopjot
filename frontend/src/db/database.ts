import Dexie, { type EntityTable } from 'dexie';
import type {
  Customer,
  Sale,
  SaleItem,
  Payment,
  Product,
  ProductUnit,
  StockMovement,
  OutboxOperation,
} from '../domain/index';

export interface Metadata {
  key: string;
  value: unknown;
}
export class LedgerDB extends Dexie {
  customers!: EntityTable<Customer, 'id'>;
  sales!: EntityTable<Sale, 'id'>;
  saleItems!: EntityTable<SaleItem, 'id'>;
  payments!: EntityTable<Payment, 'id'>;
  products!: EntityTable<Product, 'id'>;
  productUnits!: EntityTable<ProductUnit, 'id'>;
  stockMovements!: EntityTable<StockMovement, 'id'>;
  outbox!: EntityTable<OutboxOperation, 'operationId'>;
  metadata!: EntityTable<Metadata, 'key'>;
  constructor(name = 'doris-foods-ledger') {
    super(name);
    this.version(1).stores({
      customers: 'id, storeId, normalizedName',
      sales: 'id, storeId, customerId, occurredAt',
      saleItems: 'id, storeId, saleId, productUnitId',
      payments: 'id, storeId, saleId, receivedAt',
      products: 'id, storeId, normalizedName',
      productUnits: 'id, storeId, productId, &[productId+normalizedLabel]',
      stockMovements: 'id, storeId, productUnitId, saleItemId',
      outbox: 'operationId, storeId, status, createdAt',
      metadata: 'key',
    });
    this.version(2)
      .stores({ outbox: 'operationId, storeId, status, createdAt, sequence' })
      .upgrade(async (tx) => {
        const operations = (await tx
          .table('outbox')
          .orderBy('createdAt')
          .toArray()) as OutboxOperation[];
        const producers = new Map<string, OutboxOperation>();
        for (const op of operations) {
          const p = op.payload as { sale?: { id: string }; unit?: { id: string } };
          if (p.sale) producers.set(p.sale.id, op);
          if (p.unit) producers.set(p.unit.id, op);
        }
        const visited = new Set<string>(),
          visiting = new Set<string>();
        let sequence = 0;
        async function visit(op: OutboxOperation): Promise<void> {
          if (visited.has(op.operationId)) return;
          if (visiting.has(op.operationId))
            throw new Error('The existing backup queue has a dependency cycle.');
          visiting.add(op.operationId);
          const p = op.payload as {
            items?: { id: string; productUnitId: string | null; position?: number }[];
            saleId?: string;
            unitId?: string;
          };
          const dependencies = [...(p.items ?? []).map((i) => i.productUnitId), p.saleId, p.unitId];
          for (const dependency of dependencies)
            if (dependency && producers.has(dependency)) await visit(producers.get(dependency)!);
          for (const [position, item] of (p.items ?? []).entries())
            if (item.position === undefined) {
              item.position = position;
              await tx.table('saleItems').update(item.id, { position });
            }
          visited.add(op.operationId);
          visiting.delete(op.operationId);
          await tx.table('outbox').put({ ...op, sequence: ++sequence });
        }
        for (const op of operations) await visit(op);
        await tx.table('metadata').put({ key: 'queue-sequence', value: sequence });
      });
  }
}
export const db = new LedgerDB();
export interface DeviceIdentity {
  storeId: string;
  deviceId: string;
}
export async function getIdentity(database = db): Promise<DeviceIdentity> {
  return database.transaction('rw', database.metadata, async () => {
    const saved = await database.metadata.get('identity');
    if (saved) return saved.value as DeviceIdentity;
    const value = { storeId: crypto.randomUUID(), deviceId: crypto.randomUUID() };
    await database.metadata.add({ key: 'identity', value });
    return value;
  });
}
