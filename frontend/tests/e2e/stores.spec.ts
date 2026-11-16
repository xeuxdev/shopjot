import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { createStore } from '../helpers/store';

test('creates a guest store offline, retains its ID after reload, and exports its name', async ({
  page,
  context,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Let’s open your store' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
  await context.setOffline(true);
  await page.getByLabel('Store name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Create store & get started' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a name');
  await page.getByLabel('Store name', { exact: true }).fill('Nnéka’s Corner Shop');
  await page.getByRole('button', { name: 'Create store & get started' }).click();
  await expect(page.getByRole('heading', { name: 'Your shop, at a glance.' })).toBeVisible();
  await page.goto('/settings');
  const storeId = await page.locator('.store-id').innerText();
  expect(storeId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator('.store-name')).toHaveText('Nnéka’s Corner Shop');
  await page.reload();
  await expect(page.locator('.store-id')).toHaveText(storeId);
  await expect(page.locator('.store-name')).toHaveText('Nnéka’s Corner Shop');
  await expect(page.getByText('Not connected · local use')).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full JSON copy' }).click();
  const download = await downloaded;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported).toMatchObject({ storeId, store: { id: storeId, name: 'Nnéka’s Corner Shop' } });
  expect(exported.account).toBeUndefined();
  expect(exported.metadata).toBeUndefined();
  await context.setOffline(false);
  expect(apiRequests).toEqual([]);
});

test('setup and sign-in screens have accessible labels and contrast', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Store name', { exact: true })).toBeVisible();
  for (const mode of ['create', 'login']) {
    if (mode === 'login') await page.getByRole('button', { name: 'Sign in to your store' }).click();
    if (mode === 'login')
      await expect(
        page.getByRole('button', { name: 'Sign in and restore', exact: true }),
      ).toBeInViewport();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.failureSummary) })),
    ).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/shopjot-sign-in-mobile.png', fullPage: true });
});

test('long store names fit on a 320px phone and keep their full name in settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const name = '阿姨的商店 '.repeat(20).trim();
  await createStore(page, name);
  for (const path of ['/', '/settings']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await expect(page.locator('.store-name')).toHaveText(name);
});

test('two stores with the same name have separate accounts, IDs and backups', async ({
  browser,
  baseURL,
}) => {
  test.skip(!process.env.SYNC_E2E, 'Requires an isolated test database and the API.');
  test.setTimeout(60_000);
  const a = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } });
  const b = await browser.newContext({ baseURL, viewport: { width: 360, height: 800 } });
  try {
    const ids: string[] = [];
    for (const [index, context] of [a, b].entries()) {
      const page = await context.newPage();
      await createStore(page, 'Corner Shop');
      await page.goto('/settings');
      ids.push(await page.locator('.store-id').innerText());
      await page.getByLabel('Owner email').fill(`shop-${crypto.randomUUID()}@example.test`);
      await page.getByLabel('Password', { exact: true }).fill('test-password-123');
      await page.getByLabel('The records on this phone belong').check();
      await page.getByRole('button', { name: 'Create account & back up' }).click();
      await expect(page.locator('.backup-pill')).toHaveText('Backed up', { timeout: 30_000 });
      await page.goto('/sales/new');
      await page.getByLabel('Customer name').fill(`Customer ${index + 1}`);
      await page.getByLabel('Item name').fill('Rice');
      await page.getByLabel('Quantity', { exact: true }).fill('1');
      await page.getByLabel('Unit / label').fill('mudu');
      await page.getByLabel('Price per unit (₦)').fill(String((index + 1) * 1000));
      await page.getByRole('button', { name: 'Save sale', exact: true }).click();
      await expect(page.locator('.receipt-total strong')).toHaveText(
        index === 0 ? '₦1,000' : '₦2,000',
      );
      await expect(page.locator('.backup-pill')).toHaveText('Backed up', { timeout: 30_000 });
      await page.goto('/');
      await expect(page.locator('.sales-stat .stat-value')).toHaveText(
        index === 0 ? '₦1,000' : '₦2,000',
      );
    }
    expect(ids[0]).not.toBe(ids[1]);
    const api = (process.env.SYNC_API_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    for (const [index, context] of [a, b].entries()) {
      const account = await (await context.request.get(`${api}/api/auth/me`)).json();
      expect(account).toMatchObject({ storeId: ids[index], storeName: 'Corner Shop' });
      const backup = await (
        await context.request.get(`${api}/api/sync/manifest?storeId=${ids[1 - index]}`)
      ).json();
      expect(backup.counts.sales).toBe(1);
      const pull = await (
        await context.request.get(`${api}/api/sync/pull?cursor=0&storeId=${ids[1 - index]}`)
      ).json();
      expect(
        pull.changes.every(
          (change: { record: { storeId: string } }) => change.record.storeId === ids[index],
        ),
      ).toBe(true);
    }
  } finally {
    await a.close();
    await b.close();
  }
});
