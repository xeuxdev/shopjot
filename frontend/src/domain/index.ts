import { z } from 'zod';
export { z, ZodError } from 'zod';

export const STORE_TIMEZONE = 'Africa/Lagos';
export const normalize = (value: string) =>
  value.trim().normalize('NFKC').toLocaleLowerCase('en-NG').replace(/\s+/g, ' ');
export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(160, 'Use 160 characters or fewer.');
export const koboSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const quantitySchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Use a positive quantity with up to 3 decimal places.')
  .pipe(z.string().refine((v) => decimalToMilli(v) > 0n, 'Quantity must be greater than zero.'));

export function decimalToMilli(value: string): bigint {
  if (!/^-?\d+(\.\d{1,3})?$/.test(value))
    throw new Error('Use up to 3 decimal places for quantities.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return negative ? -result : result;
}
export function milliToDecimal(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / 1000n}${fraction ? `.${fraction}` : ''}`;
}
export class MoneyRangeError extends RangeError {
  name = 'MoneyRangeError';
  constructor() {
    super('This amount is too large. Reduce the quantities or prices.');
  }
}
function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyRangeError();
  return Number(value);
}
export function parseNaira(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim()))
    throw new Error('Enter a valid amount with up to 2 decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  return safeInteger(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}
export function lineTotal(quantity: string, unitPriceKobo: number): number {
  quantitySchema.parse(quantity);
  koboSchema.parse(unitPriceKobo);
  return safeInteger((decimalToMilli(quantity) * BigInt(unitPriceKobo) + 500n) / 1000n);
}
export function sumKobo(values: number[]): number {
  return safeInteger(values.reduce((sum, value) => sum + BigInt(koboSchema.parse(value)), 0n));
}
const currencyFormatter = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});
export function nairaInput(kobo: number): string {
  koboSchema.parse(kobo);
  const value = BigInt(kobo),
    cents = value % 100n;
  return `${value / 100n}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}
export function money(kobo: number): string {
  koboSchema.parse(kobo);
  const value = BigInt(kobo),
    cents = value % 100n;
  return `${currencyFormatter.format(value / 100n)}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}
export function localDay(iso: string | Date, timezone = STORE_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  return ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join('-');
}
export const saleItemInputSchema = z.object({
  id: z.uuid(),
  name: nameSchema,
  quantity: quantitySchema,
  quantityLabel: nameSchema,
  unitPriceKobo: koboSchema,
  productUnitId: z.uuid().nullable(),
});
export const saleInputSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    customerId: z.uuid().optional(),
    customerName: nameSchema,
    occurredAt: z.iso.datetime(),
    items: z.array(saleItemInputSchema).min(1, 'Add at least one item.').max(100),
    initialPaymentKobo: koboSchema,
    allowNegativeStock: z.boolean().default(false),
  })
  .superRefine((sale, ctx) => {
    try {
      const total = sumKobo(sale.items.map((i) => lineTotal(i.quantity, i.unitPriceKobo)));
      if (sale.initialPaymentKobo > total)
        ctx.addIssue({
          code: 'custom',
          path: ['initialPaymentKobo'],
          message: 'Amount received cannot exceed the sale total.',
        });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'The sale total is too large.' });
    }
  });
export type SaleInput = z.input<typeof saleInputSchema>;
export interface Scoped {
  id: string;
  storeId: string;
  createdAt: string;
}
export interface Customer extends Scoped {
  name: string;
  normalizedName: string;
  phone: string | null;
  updatedAt: string;
}
export interface Sale extends Scoped {
  customerId: string;
  totalKobo: number;
  occurredAt: string;
  status: 'active' | 'voided';
}
export interface SaleItem extends Scoped {
  saleId: string;
  position: number;
  name: string;
  quantity: string;
  quantityLabel: string;
  unitPriceKobo: number;
  lineTotalKobo: number;
  productUnitId: string | null;
}
export interface Payment extends Scoped {
  saleId: string;
  amountKobo: number;
  receivedAt: string;
  reversalOf: string | null;
}
export interface Product extends Scoped {
  name: string;
  normalizedName: string;
  active: boolean;
  updatedAt: string;
}
export interface ProductUnit extends Scoped {
  productId: string;
  label: string;
  normalizedLabel: string;
  suggestedUnitPriceKobo: number;
  quantityOnHand: string;
  updatedAt: string;
}
export interface StockMovement extends Scoped {
  productUnitId: string;
  saleItemId: string | null;
  quantityDelta: string;
  reason: 'initial_stock' | 'sale' | 'manual_adjustment' | 'reversal';
  occurredAt: string;
}
export interface OutboxOperation {
  operationId: string;
  storeId: string;
  deviceId: string;
  kind: 'sale.create' | 'payment.create' | 'stock.register' | 'stock.adjust';
  payload: unknown;
  createdAt: string;
  status: 'pending' | 'failed' | 'acknowledged';
  sequence?: number;
  acknowledgedAt?: string;
  attemptCount: number;
  error?: string;
}

export * from './sync';

export function receivedFor(saleId: string, payments: Payment[]): number {
  const reversed = new Set(payments.filter((p) => p.reversalOf).map((p) => p.reversalOf));
  return sumKobo(
    payments
      .filter((p) => p.saleId === saleId && !p.reversalOf && !reversed.has(p.id))
      .map((p) => p.amountKobo),
  );
}
export function outstandingFor(sale: Sale, payments: Payment[]): number {
  return sale.status === 'voided' ? 0 : sale.totalKobo - receivedFor(sale.id, payments);
}
export function paymentStatus(sale: Sale, payments: Payment[]): 'paid' | 'partial' | 'unpaid' {
  const received = receivedFor(sale.id, payments);
  return received === sale.totalKobo ? 'paid' : received === 0 ? 'unpaid' : 'partial';
}
export function dashboard(sales: Sale[], payments: Payment[], now = new Date()) {
  const today = localDay(now);
  const active = sales.filter((s) => s.status === 'active');
  const ids = new Set(active.map((s) => s.id));
  const reversed = new Set(payments.filter((p) => p.reversalOf).map((p) => p.reversalOf));
  const todaySales = active.filter((s) => localDay(s.occurredAt) === today);
  return {
    salesKobo: sumKobo(todaySales.map((s) => s.totalKobo)),
    collectedKobo: sumKobo(
      payments
        .filter(
          (p) =>
            ids.has(p.saleId) &&
            !p.reversalOf &&
            !reversed.has(p.id) &&
            localDay(p.receivedAt) === today,
        )
        .map((p) => p.amountKobo),
    ),
    owedKobo: sumKobo(active.map((s) => outstandingFor(s, payments))),
    saleCount: todaySales.length,
  };
}
