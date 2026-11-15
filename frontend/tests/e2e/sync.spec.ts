import { test, expect } from '@playwright/test';

test.describe('connected backup and recovery', () => {
  test.skip(!process.env.SYNC_E2E, 'Requires an API and an isolated PostgreSQL test database.');
  test('adopts queued records, recovers a dropped response, syncs offline changes and restores another phone', async ({
    page,
    context,
    browser,
  }) => {
    test.setTimeout(90_000);
    const email = `browser-${crypto.randomUUID()}@example.test`,
      password = 'browser-test-password-123';
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.goto('/stock');
    await page.getByRole('button', { name: 'Add stock item', exact: true }).click();
    await page.getByLabel('Product name').fill('Rice');
    await page.getByLabel('Quantity label').fill('mudu');
    await page.getByLabel('Current stock').fill('15');
    await page.getByLabel('Price per unit (₦)').fill('3500');
    await page.getByRole('button', { name: 'Save stock item' }).click();
    await expect(page.locator('.stock-row')).toContainText('15');
    await page.goto('/sales/new');
    await page.getByLabel('Customer name').fill('Mama Chika');
    await page.getByLabel('Item name').fill('Rice');
    await page.getByRole('button', { name: /Rice.*15 mudu in stock/ }).click();
    await page.getByLabel('Quantity', { exact: true }).fill('2');
    await page.getByRole('radio', { name: 'Part payment' }).check();
    await page.getByLabel('Amount received (₦)').fill('5000');
    await page.getByRole('button', { name: 'Save sale', exact: true }).click();
    await expect(page.locator('.balance-due strong')).toHaveText('₦2,000');
    const firstSaleUrl = page.url();
    let dropped = false;
    await page.route('**/api/sync/push', async (route) => {
      if (dropped) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      if (response.ok()) {
        dropped = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.goto('/settings');
    await page.getByLabel('Owner email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('The records on this phone belong').check();
    await page.getByRole('button', { name: 'Create account & back up' }).click();
    await expect(page.locator('.backup-pill')).toHaveText('Backed up', { timeout: 30_000 });
    expect(dropped).toBe(true);
    await page.unroute('**/api/sync/push');
    await context.setOffline(true);
    await page.goto('/sales/new');
    await page.getByLabel('Customer name').fill('Mama Chika');
    await page
      .locator('.suggestions')
      .getByRole('button', { name: /Mama Chika/ })
      .click();
    await page.getByLabel('Item name').fill('Tomato');
    await page.getByLabel('Quantity', { exact: true }).fill('2');
    await page.getByLabel('Unit / label').fill('small heap');
    await page.getByLabel('Price per unit (₦)').fill('250');
    await page.getByRole('button', { name: 'Save sale', exact: true }).click();
    await expect(page.locator('.receipt-total strong')).toHaveText('₦500');
    await page.reload();
    await expect(page.locator('.receipt-item')).toContainText('small heap');
    await page.goto(firstSaleUrl);
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await page.getByLabel('Amount received (₦)').fill('1000');
    await page.getByRole('button', { name: 'Save payment', exact: true }).click();
    await expect(page.locator('.balance-due strong')).toHaveText('₦1,000');
    await page.goto('/stock');
    await page.getByRole('button', { name: 'Adjust count' }).click();
    await page.getByLabel('New count (mudu)').fill('12.5');
    await page.getByRole('button', { name: 'Confirm new count' }).click();
    await expect(page.locator('.stock-row .row-amount > strong')).toHaveText('12.5 mudu');
    await context.setOffline(false);
    await expect(page.locator('.backup-pill')).toHaveText('Backed up', { timeout: 30_000 });
    const apiOrigin = (process.env.SYNC_API_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    const proof = await (await page.request.get(`${apiOrigin}/api/sync/manifest`)).json();
    expect(proof.counts).toEqual({
      customers: 1,
      products: 1,
      units: 1,
      sales: 2,
      items: 2,
      payments: 3,
      movements: 3,
    });
    const replacement = await browser.newContext({ viewport: { width: 360, height: 800 } });
    try {
      const restored = await replacement.newPage();
      await restored.goto(new URL('/settings', firstSaleUrl).href);
      await restored.getByRole('button', { name: 'Sign in / restore', exact: true }).click();
      await restored.getByLabel('Owner email').fill(email);
      await restored.getByLabel('Password', { exact: true }).fill(password);
      await restored.getByRole('button', { name: 'Sign in and restore', exact: true }).click();
      await expect(restored.locator('.backup-pill')).toHaveText('Read-only phone', {
        timeout: 30_000,
      });
      await expect(
        restored.getByRole('button', { name: 'Make this the primary phone' }),
      ).toBeVisible();
      await restored.goto(new URL('/', firstSaleUrl).href);
      await expect(restored.locator('.sales-stat .stat-value')).toHaveText('₦7,500');
      await expect(restored.locator('.stat .stat-value').first()).toHaveText('₦6,500');
      await expect(restored.locator('.stat .stat-value').last()).toHaveText('₦1,000');
      await restored.goto(new URL('/stock', firstSaleUrl).href);
      await expect(restored.locator('.stock-row .row-amount > strong')).toHaveText('12.5 mudu');
      await restored.goto(new URL('/settings', firstSaleUrl).href);
      await restored.getByLabel('I have backed up the previous phone').check();
      await restored.getByRole('button', { name: 'Make this the primary phone' }).click();
      await expect(restored.locator('.backup-pill')).toHaveText('Backed up', { timeout: 30_000 });
    } finally {
      await replacement.close();
    }
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Retry backup / verify records' }).click();
    await expect(page.locator('.backup-pill')).toHaveText('Read-only phone', { timeout: 30_000 });
  });
});
