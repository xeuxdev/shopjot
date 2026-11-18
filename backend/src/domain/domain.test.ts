import { describe, expect, it } from 'vitest';
import {
  dashboard,
  decimalToMilli,
  lineTotal,
  localDay,
  milliToDecimal,
  money,
  MoneyRangeError,
  nairaInput,
  normalize,
  outstandingFor,
  parseNaira,
  paymentStatus,
  quantitySchema,
  saleInputSchema,
  sumKobo,
  type Payment,
  type Sale,
} from './index';

const id = () => crypto.randomUUID();
const storeId = id();
const sale = (totalKobo: number, occurredAt = '2026-11-14T12:00:00.000Z'): Sale => ({
  id: id(),
  storeId,
  customerId: id(),
  totalKobo,
  occurredAt,
  createdAt: occurredAt,
  status: 'active',
});
const payment = (
  saleId: string,
  amountKobo: number,
  receivedAt = '2026-11-14T12:00:00.000Z',
): Payment => ({
  id: id(),
  storeId,
  saleId,
  amountKobo,
  receivedAt,
  createdAt: receivedAt,
  reversalOf: null,
});
describe('exact naira and quantity arithmetic', () => {
  it('calculates the handoff example and fractional quantities', () => {
    expect(lineTotal('2', parseNaira('3500'))).toBe(700000);
    expect(lineTotal('1.25', 101)).toBe(126);
    expect(lineTotal('0.5', 1)).toBe(1);
    expect(parseNaira('12450.50')).toBe(1245050);
  });
  it('rejects invalid amounts and precision rather than silently rounding input', () => {
    for (const value of ['-1', 'NaN', '1.111', '', 'Infinity'])
      expect(() => parseNaira(value)).toThrow();
    for (const q of ['0', '-1', '1.0001', 'no']) {
      expect(() => lineTotal(q, 100)).toThrow();
      expect(quantitySchema.safeParse(q).success).toBe(false);
    }
    expect(() => lineTotal('1', -1)).toThrow();
  });
  it('does not overflow safe money integers', () => {
    expect(() => sumKobo([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => parseNaira('9007199254740992')).toThrow();
    expect(money(Number.MAX_SAFE_INTEGER)).toBe('₦90,071,992,547,409.91');
    expect(nairaInput(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
  });
  it('rounds each line half up to one kobo at the fractional boundary', () => {
    expect(lineTotal('0.001', 499)).toBe(0);
    expect(lineTotal('0.001', 500)).toBe(1);
    expect(lineTotal('0.001', 501)).toBe(1);
    expect(lineTotal('1.999', 125)).toBe(250);
    expect(sumKobo([lineTotal('0.5', 1), lineTotal('0.5', 1)])).toBe(2);
    expect(lineTotal('1', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => lineTotal('1.001', Number.MAX_SAFE_INTEGER)).toThrow(MoneyRangeError);
  });
  it('round-trips exact kobo values through user input up to the supported limit', () => {
    const values = [
      0,
      1,
      9,
      10,
      99,
      100,
      101,
      999,
      10001,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ];
    let seed = 17;
    for (let index = 0; index < 1000; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      values.push(seed * 1000000 + (index % 100));
    }
    for (const value of values) expect(parseNaira(nairaInput(value))).toBe(value);
    expect(parseNaira('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseNaira('90071992547409.92')).toThrow(MoneyRangeError);
  });
  it('rejects unsafe, non-finite and fractional kobo values before arithmetic or display', () => {
    for (const value of [-1, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => lineTotal('1', value)).toThrow();
      expect(() => sumKobo([value])).toThrow();
      expect(() => money(value)).toThrow();
      expect(() => nairaInput(value)).toThrow();
    }
    expect(sumKobo(Array(10000).fill(1))).toBe(10000);
  });
  it('adds and subtracts fractional stock without binary floating point', () => {
    expect(milliToDecimal(decimalToMilli('15') - decimalToMilli('1.125'))).toBe('13.875');
    expect(milliToDecimal(-1n)).toBe('-0.001');
  });
});
describe('ledger accounting', () => {
  it('tracks part payment and a later repayment', () => {
    const s = sale(1150000);
    const ps = [payment(s.id, 500000)];
    expect(outstandingFor(s, ps)).toBe(650000);
    expect(paymentStatus(s, ps)).toBe('partial');
    ps.push(payment(s.id, 200000));
    expect(outstandingFor(s, ps)).toBe(450000);
  });
  it('separates daily sales from collections on older debt', () => {
    const today = sale(10000000);
    const old = sale(2000000, '2026-11-12T10:00:00.000Z');
    const ps = [payment(today.id, 6000000), payment(old.id, 1500000)];
    expect(dashboard([today, old], ps, new Date('2026-11-14T20:00:00.000Z'))).toEqual({
      salesKobo: 10000000,
      collectedKobo: 7500000,
      owedKobo: 4500000,
      saleCount: 1,
    });
  });
  it('uses Lagos day boundaries', () => {
    expect(localDay('2026-11-13T23:00:00.000Z')).toBe('2026-11-14');
    expect(localDay('2026-11-13T22:59:59.000Z')).toBe('2026-11-13');
  });
  it('assigns sales and repayments to the correct side of Lagos midnight', () => {
    const before = '2026-11-13T22:59:59.999Z';
    const after = '2026-11-13T23:00:00.000Z';
    const s = sale(101, before);
    const payments = [payment(s.id, 1, before), payment(s.id, 100, after)];
    expect(dashboard([s], payments, new Date(before))).toEqual({
      salesKobo: 101,
      collectedKobo: 1,
      owedKobo: 0,
      saleCount: 1,
    });
    expect(dashboard([s], payments, new Date(after))).toEqual({
      salesKobo: 0,
      collectedKobo: 100,
      owedKobo: 0,
      saleCount: 0,
    });
    expect(paymentStatus(s, payments)).toBe('paid');
  });
  it('excludes voided sales and reversed payments from accounting', () => {
    const s = sale(1000);
    const p = payment(s.id, 300);
    const reverse = { ...payment(s.id, 300), reversalOf: p.id };
    expect(outstandingFor(s, [p, reverse])).toBe(1000);
    expect(dashboard([{ ...s, status: 'voided' }], [p], new Date(s.occurredAt)).owedKobo).toBe(0);
  });
  it('keeps Unicode names intact when making search keys', () => {
    expect(normalize('  Nnéka O’Doris  ')).toBe('nnéka o’doris');
  });
  it('accepts new unit labels and rejects overpayment or unnamed customers', () => {
    const input = {
      id: id(),
      operationId: id(),
      customerName: 'Mama Chika',
      occurredAt: '2026-11-14T10:00:00.000Z',
      initialPaymentKobo: 0,
      items: [
        {
          id: id(),
          name: 'Garden eggs',
          quantity: '1.5',
          quantityLabel: 'small heap',
          unitPriceKobo: 10000,
          productUnitId: null,
        },
      ],
    };
    expect(saleInputSchema.parse(input).items[0].quantityLabel).toBe('small heap');
    expect(saleInputSchema.safeParse({ ...input, customerName: ' ' }).success).toBe(false);
    expect(saleInputSchema.safeParse({ ...input, initialPaymentKobo: 15001 }).success).toBe(false);
  });
});
