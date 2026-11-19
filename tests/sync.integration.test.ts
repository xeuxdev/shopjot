import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  canonicalJson,
  outstandingFor,
  snapshotJson,
  type SaleInput,
} from '../frontend/src/domain';
import { createApp } from '../backend/src/app';
import { makeDatabase } from '../backend/src/db/client';
import * as tables from '../backend/src/db/schema';
import { readSnapshot } from '../backend/src/records';
import { LedgerDB, getIdentity } from '../frontend/src/db/database';
import { createLocalStore } from '../frontend/src/db/store';
import {
  adjustStock,
  recordPayment,
  registerStock,
  saveSale,
  voidSale,
  recordCustomerPayment,
} from '../frontend/src/db/ledger';
import { runSync, localSnapshot, toWire } from '../frontend/src/features/sync/engine';
import { HttpError } from '../frontend/src/features/sync/http';
import type { LocalAccount, SyncState } from '../frontend/src/db/sync-state';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'authenticated end-to-end ledger sync with PostgreSQL',
  () => {
    const { db, pool } = makeDatabase(process.env.TEST_DATABASE_URL);
    const app = createApp({ database: db, logger: false });
    const origin = 'http://127.0.0.1:5173',
      password = 'test-only-password-123';
    const storeIds: string[] = [],
      userIds: string[] = [],
      locals: LedgerDB[] = [];
    let clientIndex = 0;
    async function owner(storeName = 'Shopjot Test') {
      const local = new LedgerDB(`sync-test-${crypto.randomUUID()}`);
      locals.push(local);
      await createLocalStore(storeName, local);
      const identity = await getIdentity(local),
        email = `${identity.storeId}@example.test`;
      const address = `127.0.0.${++clientIndex}`;
      const registration = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: address,
        headers: { origin },
        payload: { email, password, ...identity, storeName },
      });
      expect(registration.statusCode).toBe(200);
      const account = registration.json() as LocalAccount;
      storeIds.push(account.storeId);
      userIds.push(account.userId);
      const cookie = `doris_session=${registration.cookies.find((c) => c.name === 'doris_session')!.value}`;
      await local.metadata.put({ key: 'account', value: { ...account, restoreReady: true } });
      const request = transport(cookie, address);
      return { local, identity, email, account, cookie, request, address };
    }
    function transport(cookie: string, address = '127.0.0.250') {
      return async (path: string, init: RequestInit = {}): Promise<unknown> => {
        const response = await app.inject({
          method: init.method === 'POST' ? 'POST' : 'GET',
          url: `/api${path}`,
          remoteAddress: address,
          headers: { origin, cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) },
          payload: init.body ? String(init.body) : undefined,
        });
        if (response.statusCode >= 400)
          throw new HttpError(response.statusCode, response.json().code, response.json().message);
        return response.json();
      };
    }
    async function anotherPhone(o: Awaited<ReturnType<typeof owner>>) {
      const local = new LedgerDB(`shared-phone-${crypto.randomUUID()}`);
      locals.push(local);
      const identity = await getIdentity(local);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: o.address,
        headers: { origin },
        payload: { email: o.email, password, deviceId: identity.deviceId },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().writer).toBe(true);
      const cookie = `doris_session=${login.cookies.find((c) => c.name === 'doris_session')!.value}`;
      const signedInIdentity = { ...identity, storeId: o.account.storeId };
      await local.metadata.bulkPut([
        { key: 'identity', value: signedInIdentity },
        { key: 'account', value: { ...login.json<LocalAccount>(), restoreReady: false } },
      ]);
      const request = transport(cookie, o.address);
      return { local, identity: signedInIdentity, login, cookie, request };
    }
    const saleInput = (unitId: string | null = null): SaleInput => ({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      customerName: 'Mama Chika',
      occurredAt: new Date().toISOString(),
      initialPaymentKobo: 500000,
      items: [
        {
          id: crypto.randomUUID(),
          name: 'Rice',
          quantity: '2',
          quantityLabel: 'mudu',
          unitPriceKobo: 350000,
          productUnitId: unitId,
        },
        {
          id: crypto.randomUUID(),
          name: 'Groundnut oil',
          quantity: '1',
          quantityLabel: 'small heap',
          unitPriceKobo: 450000,
          productUnitId: null,
        },
      ],
    });
    afterAll(async () => {
      for (const local of locals) await local.delete();
      if (storeIds.length) {
        for (const table of [
          tables.syncChanges,
          tables.processedSyncOperations,
          tables.stockMovements,
          tables.payments,
          tables.saleItems,
          tables.sales,
          tables.productUnits,
          tables.products,
          tables.customers,
        ])
          await db.delete(table).where(inArray(table.storeId, storeIds));
        await db.delete(tables.sessions).where(inArray(tables.sessions.userId, userIds));
        await db.delete(tables.stores).where(inArray(tables.stores.id, storeIds));
        await db.delete(tables.users).where(inArray(tables.users.id, userIds));
      }
      await app.close();
      await pool.end();
    });
    it('syncs audited corrections and grouped payments, retries and restores the same history', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '15', 350000, crypto.randomUUID(), o.local);
      const unit = (await o.local.productUnits.toArray())[0];
      const originalInput = saleInput(unit.id);
      const original = await saveSale(originalInput, o.local);
      await recordPayment(original.id, 100000, crypto.randomUUID(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const originals = await o.local.payments.toArray();
      const corrected = saleInput(unit.id);
      corrected.customerId = original.customerId;
      corrected.occurredAt = original.occurredAt;
      corrected.initialPaymentKobo = 600000;
      corrected.items[0].quantity = '3';
      corrected.correction = {
        saleId: original.id,
        reason: 'Wrong quantity',
        expectedPaymentIds: originals.map((p) => p.id),
      };
      const replacement = await saveSale(corrected, o.local);
      let lost = false;
      const unreliable: typeof o.request = async (path, init) => {
        const result = await o.request(path, init);
        if (path === '/sync/push' && !lost) {
          lost = true;
          throw new TypeError('Response lost');
        }
        return result;
      };
      expect(await runSync({ database: o.local, request: unreliable, force: true })).toBe('retry');
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      let remote = await readSnapshot(db, o.account.storeId);
      expect(remote.sales.find((sale) => sale.id === original.id)).toMatchObject({
        status: 'voided',
        voidReason: 'Wrong quantity',
      });
      expect(remote.units[0].quantityOnHand).toBe('12');
      expect(snapshotJson(remote)).toBe(
        snapshotJson(await localSnapshot(o.local, o.account.storeId)),
      );
      const nextInput = saleInput();
      nextInput.customerId = original.customerId;
      nextInput.initialPaymentKobo = 0;
      const next = await saveSale(nextInput, o.local);
      await recordCustomerPayment(
        original.customerId,
        [
          { saleId: replacement.id, amountKobo: 100000 },
          { saleId: next.id, amountKobo: 100000 },
        ],
        crypto.randomUUID(),
        o.local,
      );
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const phone = await anotherPhone(o);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      expect(snapshotJson(await localSnapshot(phone.local, o.account.storeId))).toBe(
        snapshotJson(await localSnapshot(o.local, o.account.storeId)),
      );
      const expected = (await o.local.payments.toArray())
        .filter((p) => p.saleId === replacement.id && !p.reversalOf)
        .map((p) => p.id);
      await voidSale(replacement.id, 'Goods returned', expected, crypto.randomUUID(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      remote = await readSnapshot(db, o.account.storeId);
      expect(remote.units[0].quantityOnHand).toBe('15');
      expect(snapshotJson(remote)).toBe(
        snapshotJson(await localSnapshot(o.local, o.account.storeId)),
      );
    });
    it('rejects a stale correction atomically when another phone has collected a payment', async () => {
      const o = await owner();
      const original = await saveSale(saleInput(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const phone = await anotherPhone(o);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      const expected = (await o.local.payments.toArray()).map((p) => p.id);
      const correction = saleInput();
      correction.customerId = original.customerId;
      correction.occurredAt = original.occurredAt;
      correction.correction = {
        saleId: original.id,
        reason: 'Wrong goods',
        expectedPaymentIds: expected,
      };
      await saveSale(correction, o.local);
      await recordPayment(original.id, 100000, crypto.randomUUID(), phone.local);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('blocked');
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.sales).toHaveLength(1);
      expect(remote.sales[0].status).toBe('active');
      expect(remote.payments).toHaveLength(2);
      expect(remote.payments.every((p) => p.reversalOf === null)).toBe(true);
      expect((await o.local.outbox.get(correction.operationId))?.error).toContain(
        'Payments changed',
      );
    });
    it('rolls back a grouped repayment when another phone has paid one selected sale', async () => {
      const o = await owner();
      const first = await saveSale(saleInput(), o.local);
      const raw = saleInput();
      raw.customerId = first.customerId;
      const second = await saveSale(raw, o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const phone = await anotherPhone(o);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      const operationId = crypto.randomUUID();
      await recordCustomerPayment(
        first.customerId,
        [
          { saleId: first.id, amountKobo: 100000 },
          { saleId: second.id, amountKobo: 100000 },
        ],
        operationId,
        o.local,
      );
      await recordPayment(second.id, 650000, crypto.randomUUID(), phone.local);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      const before = await readSnapshot(db, o.account.storeId);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('blocked');
      expect(snapshotJson(await readSnapshot(db, o.account.storeId))).toBe(snapshotJson(before));
      expect((await o.local.outbox.get(operationId))?.status).toBe('failed');
    });
    it('rejects forged audit reversals without changing server payments or stock', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '15', 350000, crypto.randomUUID(), o.local);
      const unit = (await o.local.productUnits.toArray())[0];
      const original = await saveSale(saleInput(unit.id), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const before = await readSnapshot(db, o.account.storeId);
      const corrected = saleInput(unit.id);
      corrected.customerId = original.customerId;
      corrected.occurredAt = original.occurredAt;
      corrected.correction = {
        saleId: original.id,
        reason: 'Wrong quantity',
        expectedPaymentIds: before.payments.map((p) => p.id),
      };
      await saveSale(corrected, o.local);
      const operation = await toWire((await o.local.outbox.get(corrected.operationId))!, o.local);
      if (operation.kind !== 'sale.create' || !operation.payload.correction)
        throw new Error('Missing correction');
      operation.payload.correction.reversals[0].amountKobo++;
      await expect(
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(operation) }),
      ).rejects.toThrow('Invalid payment reversal');
      expect(snapshotJson(await readSnapshot(db, o.account.storeId))).toBe(snapshotJson(before));
      const untouched = await toWire((await o.local.outbox.get(corrected.operationId))!, o.local);
      if (untouched.kind !== 'sale.create' || !untouched.payload.correction)
        throw new Error('Missing correction');
      untouched.payload.correction.movements[0].quantityDelta = '999';
      await expect(
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(untouched) }),
      ).rejects.toThrow('Invalid stock reversal');
      expect(snapshotJson(await readSnapshot(db, o.account.storeId))).toBe(snapshotJson(before));
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
    });
    it('backs up every entity, retries lost responses, and lets both signed-in phones record sales', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '15', 350000, crypto.randomUUID(), o.local);
      const unit = (await o.local.productUnits.toArray())[0];
      const sale = await saveSale(saleInput(unit.id), o.local);
      let dropped = false;
      const unreliable: typeof o.request = async (path, init) => {
        const result = await o.request(path, init);
        if (path === '/sync/push' && !dropped) {
          dropped = true;
          throw new TypeError('Response lost after PostgreSQL commit');
        }
        return result;
      };
      expect(await runSync({ database: o.local, request: unreliable, force: true })).toBe('retry');
      expect((await o.local.outbox.toArray()).every((op) => op.status === 'pending')).toBe(true);
      expect((await o.local.metadata.get('sync'))?.value).not.toHaveProperty('lastBackupAt');
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const paymentOp = crypto.randomUUID();
      await recordPayment(sale.id, 200000, paymentOp, o.local);
      await adjustStock(unit.id, '12.125', crypto.randomUUID(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      await recordPayment(sale.id, 200000, paymentOp, o.local);
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.customers).toHaveLength(1);
      expect(remote.products).toHaveLength(1);
      expect(remote.units[0].quantityOnHand).toBe('12.125');
      expect(remote.sales).toHaveLength(1);
      expect(remote.items).toHaveLength(2);
      expect(remote.payments).toHaveLength(2);
      expect(remote.movements).toHaveLength(3);
      expect(snapshotJson(await localSnapshot(o.local, o.account.storeId))).toBe(
        snapshotJson(remote),
      );
      expect((await o.local.outbox.toArray()).every((op) => op.status === 'acknowledged')).toBe(
        true,
      );
      // Cookie proves HttpOnly/SameSite session setup; credentials never enter export/local metadata.
      expect(
        (await o.local.metadata.toArray()).some((r) => canonicalJson(r).includes(password)),
      ).toBe(false);
      const phone = await anotherPhone(o);
      const replacement = phone.local;
      const login = phone.login;
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      expect(login.headers['set-cookie']).toContain('SameSite=Strict');
      await expect(saveSale(saleInput(), replacement)).rejects.toThrow('restore');
      expect(
        await runSync({
          database: replacement,
          request: phone.request,
          force: true,
        }),
      ).toBe('done');
      expect(snapshotJson(await localSnapshot(replacement, o.account.storeId))).toBe(
        snapshotJson(remote),
      );
      // A legacy client's claim request must not revoke the first phone's access.
      const claim = await app.inject({
        method: 'POST',
        url: '/api/devices/claim',
        headers: { origin, cookie: phone.cookie },
        payload: { deviceId: phone.identity.deviceId, confirmPreviousDeviceBackedUp: true },
      });
      expect(claim.statusCode).toBe(200);
      expect(await o.request('/auth/me')).toMatchObject({ writer: true });
      await Promise.all([saveSale(saleInput(), o.local), saveSale(saleInput(), replacement)]);
      await Promise.all([
        runSync({ database: o.local, request: o.request, force: true }),
        runSync({ database: replacement, request: phone.request, force: true }),
      ]);
      // A phone may need another pass when the other phone commits during pull/verification.
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      expect(await runSync({ database: replacement, request: phone.request, force: true })).toBe(
        'done',
      );
      const shared = await readSnapshot(db, o.account.storeId);
      expect(shared.sales).toHaveLength(3);
      for (const local of [o.local, replacement]) {
        expect(snapshotJson(await localSnapshot(local, o.account.storeId))).toBe(
          snapshotJson(shared),
        );
        expect((await local.outbox.toArray()).every((op) => op.status === 'acknowledged')).toBe(
          true,
        );
        expect((await local.metadata.get('sync'))?.value).toMatchObject({ status: 'backed_up' });
      }
      const operations = await db
        .select()
        .from(tables.processedSyncOperations)
        .where(eq(tables.processedSyncOperations.storeId, o.account.storeId));
      expect(new Set(operations.map((op) => op.deviceId))).toEqual(
        new Set([o.identity.deviceId, phone.identity.deviceId]),
      );
      await o.request('/auth/logout', { method: 'POST', body: '{}' });
      await expect(o.request('/auth/me')).rejects.toMatchObject({ status: 401 });
      expect(await phone.request('/auth/me')).toMatchObject({ writer: true });
    }, 30_000);
    it('keeps stores with identical names separate and rejects cross-account access, forged totals and changed operation IDs', async () => {
      const o = await owner(),
        other = await owner();
      expect(o.account.storeName).toBe(other.account.storeName);
      expect(o.account.storeId).not.toBe(other.account.storeId);
      expect(await o.request('/auth/me')).toMatchObject({
        storeId: o.identity.storeId,
        storeName: 'Shopjot Test',
      });
      expect(await other.request('/auth/me')).toMatchObject({
        storeId: other.identity.storeId,
        storeName: 'Shopjot Test',
      });
      const sale = await saveSale(saleInput(), o.local);
      const op = (await o.local.outbox.toArray())[0],
        wire = await toWire(op, o.local);
      await expect(
        other.request('/sync/push', { method: 'POST', body: JSON.stringify(wire) }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          (await other.request(`/sync/pull?cursor=0&storeId=${o.account.storeId}`)) as {
            changes: unknown[];
          }
        ).changes,
      ).toHaveLength(0);
      if (wire.kind !== 'sale.create') throw new Error('Expected sale');
      const bad = structuredClone(wire);
      bad.payload.sale.totalKobo++;
      await expect(
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(bad) }),
      ).rejects.toMatchObject({ status: 422 });
      expect((await readSnapshot(db, o.account.storeId)).customers).toHaveLength(0);
      expect(
        await db
          .select()
          .from(tables.processedSyncOperations)
          .where(eq(tables.processedSyncOperations.storeId, o.account.storeId)),
      ).toHaveLength(0);
      await o.request('/sync/push', { method: 'POST', body: JSON.stringify(wire) });
      await expect(
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(bad) }),
      ).rejects.toMatchObject({ code: 'OPERATION_ID_REUSED' });
      // Two simultaneous distinct repayments cannot both spend the same remaining balance.
      const payment = (amount: number) => ({
        version: 1,
        operationId: crypto.randomUUID(),
        storeId: o.account.storeId,
        deviceId: o.identity.deviceId,
        kind: 'payment.create',
        payload: {
          id: crypto.randomUUID(),
          storeId: o.account.storeId,
          createdAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          saleId: sale.id,
          amountKobo: amount,
          reversalOf: null,
        },
      });
      const results = await Promise.allSettled([
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(payment(400000)) }),
        o.request('/sync/push', { method: 'POST', body: JSON.stringify(payment(400000)) }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await readSnapshot(db, o.account.storeId)).payments).toHaveLength(2);
      const mismatch = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, cookie: o.cookie },
        payload: {
          email: other.email,
          password,
          deviceId: o.identity.deviceId,
          expectedStoreId: o.account.storeId,
        },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.headers['set-cookie']).toBeUndefined();
      expect(await o.request('/auth/me')).toMatchObject({ storeId: o.account.storeId });
    }, 30_000);
    it('keeps a local orphan record visible and refuses to claim a verified backup', async () => {
      const o = await owner();
      await saveSale(saleInput(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const customer = (await o.local.customers.toArray())[0];
      await o.local.customers.add({
        ...customer,
        id: crypto.randomUUID(),
        name: 'Unqueued local record',
        normalizedName: 'unqueued local record',
      });
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('blocked');
      const state = (await o.local.metadata.get('sync'))?.value as SyncState;
      expect(state.status).toBe('failed');
      expect(state.error).toContain('verification');
      expect(await o.local.customers.count()).toBe(2);
    }, 30_000);
    it('preserves per-line rounding, fractional stock, and one-kobo repayments through PostgreSQL', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '1.001', 1, crypto.randomUUID(), o.local);
      const unit = (await o.local.productUnits.toArray())[0];
      const raw = saleInput(unit.id);
      raw.initialPaymentKobo = 1;
      raw.items = raw.items.map((item) => ({
        ...item,
        quantity: '0.5',
        quantityLabel: 'mudu',
        unitPriceKobo: 1,
        productUnitId: unit.id,
      }));
      const sale = await saveSale(raw, o.local);
      expect(sale.totalKobo).toBe(2);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const op = crypto.randomUUID();
      await recordPayment(sale.id, 1, op, o.local);
      await recordPayment(sale.id, 1, op, o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.items.map((item) => item.lineTotalKobo)).toEqual([1, 1]);
      expect(remote.units[0].quantityOnHand).toBe('0.001');
      expect(remote.movements.map((movement) => movement.quantityDelta).sort()).toEqual([
        '-0.5',
        '-0.5',
        '1.001',
      ]);
      expect(remote.payments).toHaveLength(2);
      expect(outstandingFor(remote.sales[0], remote.payments)).toBe(0);
      expect(snapshotJson(await localSnapshot(o.local, o.account.storeId))).toBe(
        snapshotJson(remote),
      );
    }, 30_000);
    it('round-trips the maximum supported kobo amount without losing a digit', async () => {
      const o = await owner();
      const raw = saleInput();
      raw.items = [{ ...raw.items[0], quantity: '1', unitPriceKobo: Number.MAX_SAFE_INTEGER }];
      raw.initialPaymentKobo = Number.MAX_SAFE_INTEGER;
      await saveSale(raw, o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.sales[0].totalKobo).toBe(Number.MAX_SAFE_INTEGER);
      expect(remote.items[0].lineTotalKobo).toBe(Number.MAX_SAFE_INTEGER);
      expect(remote.payments[0].amountKobo).toBe(Number.MAX_SAFE_INTEGER);
      expect(outstandingFor(remote.sales[0], remote.payments)).toBe(0);
    }, 30_000);
    it('rejects overflowing arithmetic as invalid input and rolls back the entire server operation', async () => {
      const o = await owner();
      await saveSale(saleInput(), o.local);
      const wire = await toWire((await o.local.outbox.toArray())[0], o.local);
      if (wire.kind !== 'sale.create') throw new Error('Expected sale');
      for (const quantity of ['1', '2']) {
        const bad = structuredClone(wire);
        bad.payload.items = bad.payload.items.map((item) => ({
          ...item,
          quantity,
          unitPriceKobo: Number.MAX_SAFE_INTEGER,
          lineTotalKobo: Number.MAX_SAFE_INTEGER,
        }));
        bad.payload.sale.totalKobo = Number.MAX_SAFE_INTEGER;
        await expect(
          o.request('/sync/push', { method: 'POST', body: JSON.stringify(bad) }),
        ).rejects.toMatchObject({ status: 422, code: 'INVALID_AMOUNT' });
        const remote = await readSnapshot(db, o.account.storeId);
        expect(remote.sales).toHaveLength(0);
        expect(remote.customers).toHaveLength(0);
        expect(remote.items).toHaveLength(0);
        expect(remote.payments).toHaveLength(0);
      }
      // The rejected ID remains usable for the original valid request.
      await o.request('/sync/push', { method: 'POST', body: JSON.stringify(wire) });
      expect((await readSnapshot(db, o.account.storeId)).sales).toHaveLength(1);
    }, 30_000);
    it('keeps sales from two offline phones when they both sell against the last stock count', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '1', 100, crypto.randomUUID(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const unit = (await o.local.productUnits.toArray())[0];
      const phone = await anotherPhone(o);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      const raw = saleInput(unit.id);
      raw.items = [{ ...raw.items[0], quantity: '1', unitPriceKobo: 100 }];
      raw.initialPaymentKobo = 100;
      const other = structuredClone(raw);
      other.id = crypto.randomUUID();
      other.operationId = crypto.randomUUID();
      other.items[0].id = crypto.randomUUID();
      await Promise.all([saveSale(raw, o.local), saveSale(other, phone.local)]);
      await Promise.all([
        runSync({ database: o.local, request: o.request, force: true }),
        runSync({ database: phone.local, request: phone.request, force: true }),
      ]);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.sales).toHaveLength(2);
      expect(remote.items).toHaveLength(2);
      expect(remote.payments).toHaveLength(2);
      expect(remote.payments.map((payment) => payment.amountKobo)).toEqual([100, 100]);
      expect(remote.units[0].quantityOnHand).toBe('-1');
      expect(remote.movements).toHaveLength(3);
      for (const local of [o.local, phone.local])
        expect(snapshotJson(await localSnapshot(local, o.account.storeId))).toBe(
          snapshotJson(remote),
        );
    }, 30_000);
    it('keeps a conflicting offline repayment for review without overpaying the shared sale', async () => {
      const o = await owner();
      const sale = await saveSale(saleInput(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const phone = await anotherPhone(o);
      expect(await runSync({ database: phone.local, request: phone.request, force: true })).toBe(
        'done',
      );
      await Promise.all([
        recordPayment(sale.id, 400000, crypto.randomUUID(), o.local),
        recordPayment(sale.id, 400000, crypto.randomUUID(), phone.local),
      ]);
      await Promise.all([
        runSync({ database: o.local, request: o.request, force: true }),
        runSync({ database: phone.local, request: phone.request, force: true }),
      ]);
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.payments).toHaveLength(2);
      expect(outstandingFor(remote.sales[0], remote.payments)).toBe(250000);
      const failures = (
        await Promise.all(
          [o.local, phone.local].map(async (local) => ({
            local,
            failed: await local.outbox.where('status').equals('failed').toArray(),
          })),
        )
      ).filter(({ failed }) => failed.length > 0);
      expect(failures).toHaveLength(1);
      const { local, failed } = failures[0];
      expect(failed[0]).toMatchObject({
        kind: 'payment.create',
        error: 'Payment exceeds the outstanding balance.',
        payload: { amountKobo: 400000 },
      });
      expect(await local.payments.count()).toBe(2);
      expect((await local.metadata.get('account'))?.value).toMatchObject({ writer: true });
      expect((await local.metadata.get('sync'))?.value).toMatchObject({ status: 'failed' });
    }, 30_000);
    it('retains a pending change after a mismatched acknowledgment and retries it after reopening IndexedDB', async () => {
      const o = await owner();
      await saveSale(saleInput(), o.local);
      const malformed: typeof o.request = async (path, init) => {
        const response = await o.request(path, init);
        return path === '/sync/push'
          ? { ...(response as object), digest: '0'.repeat(64) }
          : response;
      };
      expect(await runSync({ database: o.local, request: malformed, force: true })).toBe('retry');
      expect((await o.local.outbox.toArray())[0].status).toBe('pending');
      const name = o.local.name;
      o.local.close();
      const reopened = new LedgerDB(name);
      locals.push(reopened);
      expect(await runSync({ database: reopened, request: o.request, force: true })).toBe('done');
      expect((await reopened.outbox.toArray())[0]).toMatchObject({
        status: 'acknowledged',
        attemptCount: 2,
      });
      const records = await readSnapshot(db, o.account.storeId);
      expect(records.sales).toHaveLength(1);
      expect(records.payments).toHaveLength(1);
    }, 30_000);
    it('restores multiple change pages without advancing the cursor when a page is interrupted', async () => {
      const o = await owner();
      let customerId: string | undefined;
      for (let count = 0; count < 70; count++) {
        const input = saleInput();
        input.customerId = customerId;
        customerId = (await saveSale(input, o.local)).customerId;
      }
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const restored = new LedgerDB(`pagination-${crypto.randomUUID()}`);
      locals.push(restored);
      await restored.metadata.put({ key: 'identity', value: o.identity });
      await restored.metadata.put({ key: 'account', value: { ...o.account, restoreReady: false } });
      let pages = 0;
      const interrupted: typeof o.request = async (path, init) => {
        const result = await o.request(path, init);
        if (path.startsWith('/sync/pull') && ++pages === 2)
          throw new TypeError('Disconnected during restore');
        return result;
      };
      expect(await runSync({ database: restored, request: interrupted, force: true })).toBe(
        'retry',
      );
      expect(await restored.sales.count()).toBe(0);
      expect((await restored.metadata.get('sync'))?.value).toMatchObject({ cursor: '0' });
      expect(await runSync({ database: restored, request: o.request, force: true })).toBe('done');
      expect(await restored.sales.count()).toBe(70);
      expect(await restored.saleItems.count()).toBe(140);
      expect(snapshotJson(await localSnapshot(restored, o.account.storeId))).toBe(
        snapshotJson(await readSnapshot(db, o.account.storeId)),
      );
    }, 30_000);
  },
);
