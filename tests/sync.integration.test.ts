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
import { adjustStock, recordPayment, registerStock, saveSale } from '../frontend/src/db/ledger';
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
    it('backs up every entity, retries a response lost after commit, restores a new phone and enforces device takeover', async () => {
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
      const replacement = new LedgerDB(`restore-${crypto.randomUUID()}`);
      locals.push(replacement);
      const replacementIdentity = await getIdentity(replacement);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: o.address,
        headers: { origin },
        payload: { email: o.email, password, deviceId: replacementIdentity.deviceId },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().writer).toBe(false);
      const replacementCookie = `doris_session=${login.cookies.find((c) => c.name === 'doris_session')!.value}`;
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      expect(login.headers['set-cookie']).toContain('SameSite=Strict');
      await replacement.metadata.put({
        key: 'identity',
        value: { ...replacementIdentity, storeId: o.account.storeId },
      });
      await replacement.metadata.put({
        key: 'account',
        value: { ...login.json<LocalAccount>(), restoreReady: false },
      });
      expect(
        await runSync({
          database: replacement,
          request: transport(replacementCookie),
          force: true,
        }),
      ).toBe('done');
      expect(snapshotJson(await localSnapshot(replacement, o.account.storeId))).toBe(
        snapshotJson(remote),
      );
      await expect(saveSale(saleInput(), replacement)).rejects.toThrow('read-only');
      const claim = await app.inject({
        method: 'POST',
        url: '/api/devices/claim',
        headers: { origin, cookie: replacementCookie },
        payload: { deviceId: replacementIdentity.deviceId, confirmPreviousDeviceBackedUp: true },
      });
      expect(claim.statusCode).toBe(200);
      await saveSale(saleInput(), o.local); // Old phone still offline and unaware of takeover.
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('blocked');
      expect((await o.local.metadata.get('sync'))?.value).toMatchObject({
        status: 'device_blocked',
      });
      expect((await o.local.outbox.toArray()).filter((op) => op.status === 'pending')).toHaveLength(
        1,
      );
      expect((await readSnapshot(db, o.account.storeId)).sales).toHaveLength(1);
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
    it('serializes competing sales so only one can consume the last stock', async () => {
      const o = await owner();
      await registerStock('Rice', 'mudu', '1', 100, crypto.randomUUID(), o.local);
      expect(await runSync({ database: o.local, request: o.request, force: true })).toBe('done');
      const unit = (await o.local.productUnits.toArray())[0];
      const raw = saleInput(unit.id);
      raw.items = [{ ...raw.items[0], quantity: '1', unitPriceKobo: 100 }];
      raw.initialPaymentKobo = 0;
      await saveSale(raw, o.local);
      const queued = (await o.local.outbox.toArray()).find((op) => op.kind === 'sale.create')!;
      const first = await toWire(queued, o.local);
      if (first.kind !== 'sale.create') throw new Error('Expected sale');
      const second = structuredClone(first);
      second.operationId = crypto.randomUUID();
      second.payload.sale.id = crypto.randomUUID();
      second.payload.items[0].id = crypto.randomUUID();
      second.payload.items[0].saleId = second.payload.sale.id;
      second.payload.movements[0].id = crypto.randomUUID();
      second.payload.movements[0].saleItemId = second.payload.items[0].id;
      const results = await Promise.allSettled(
        [first, second].map((wire) =>
          o.request('/sync/push', { method: 'POST', body: JSON.stringify(wire) }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toMatchObject({ status: 'rejected', reason: { status: 422 } });
      const remote = await readSnapshot(db, o.account.storeId);
      expect(remote.sales).toHaveLength(1);
      expect(remote.items).toHaveLength(1);
      expect(remote.units[0].quantityOnHand).toBe('0');
      expect(remote.movements).toHaveLength(2);
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
