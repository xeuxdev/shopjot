import { test, expect, type Page } from '@playwright/test';

async function readyOffline(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your shop, at a glance.' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
  });
}
async function row(
  page: Page,
  index: number,
  values: { name: string; quantity: string; label: string; price: string },
) {
  const item = page.locator('.sale-item').nth(index);
  await item.getByLabel('Item name').fill(values.name);
  await item.getByLabel('Quantity', { exact: true }).fill(values.quantity);
  await item.getByLabel('Unit / label').fill(values.label);
  await item.getByLabel('Price per unit (₦)').fill(values.price);
}
test('offline arbitrary goods, draft recovery, partial payment, repayment and reload', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await readyOffline(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Record sale', exact: true }).click();
  await page.getByLabel('Customer name').fill('Mama Chika');
  await row(page, 0, { name: 'Rice', quantity: '2', label: 'mudu', price: '3500' });
  await expect(page.locator('.item-bottom strong').first()).toHaveText('₦7,000');
  await page.getByRole('button', { name: 'Add another item' }).click();
  await row(page, 1, { name: 'Groundnut oil', quantity: '1', label: 'small heap', price: '4500' });
  await page.getByRole('radio', { name: 'Part payment' }).check();
  await page.getByLabel('Amount received (₦)').fill('5000');
  await expect(page.locator('.summary-row.owed strong')).toHaveText('₦6,500');
  await page.waitForTimeout(350);
  await page.reload();
  await expect(page.getByLabel('Customer name')).toHaveValue('Mama Chika');
  await expect(page.locator('.sale-item').nth(1).getByLabel('Unit / label')).toHaveValue(
    'small heap',
  );
  await page.getByRole('button', { name: 'Save sale', exact: true }).dblclick();
  await expect(page.getByRole('heading', { name: 'Mama Chika', exact: true })).toBeVisible();
  await expect(page.locator('.balance-due strong')).toHaveText('₦6,500');
  await page.reload();
  await expect(page.locator('.receipt-item')).toHaveCount(2);
  await expect(page.locator('.receipt-item').first()).toContainText('Rice');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByLabel('Amount received (₦)').fill('7000');
  await page.getByRole('button', { name: 'Save payment', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('exceed');
  await page.getByLabel('Amount received (₦)').fill('2000');
  await page.getByRole('button', { name: 'Save payment', exact: true }).click();
  await expect(page.locator('.balance-due strong')).toHaveText('₦4,500');
  await expect(page.locator('.payment-event')).toHaveCount(2);
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Home', exact: true })
    .click();
  await expect(page.locator('.sales-stat .stat-value')).toHaveText('₦11,500');
  await expect(page.locator('.stat .stat-value').first()).toHaveText('₦7,000');
  await expect(page.locator('.stat .stat-value').last()).toHaveText('₦4,500');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/home-mobile.png', fullPage: true });
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.sales-stat .stat-value')).toHaveText('₦11,500');
  await expect(page.getByText('Backed up', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('stock link is explicit, stock counts survive reload, and CSV export works', async ({
  page,
}) => {
  await readyOffline(page);
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Stock', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add stock item', exact: true }).click();
  await page.getByLabel('Product name').fill('Rice');
  await page.getByLabel('Quantity label').fill('mudu');
  await page.getByLabel('Current stock').fill('15');
  await page.getByLabel('Price per unit (₦)').fill('3500');
  await page.getByRole('button', { name: 'Save stock item' }).click();
  await expect(page.locator('.stock-row')).toContainText('15');
  await page.goto('/sales/new');
  await page.getByLabel('Customer name').fill('Nnéka O’Doris');
  await page.getByLabel('Item name').fill('Rice');
  await page.getByRole('button', { name: /Rice.*15 mudu in stock/ }).click();
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.locator('.receipt-item')).toContainText('Linked to stock');
  await page.goto('/stock');
  await expect(page.locator('.stock-row .row-amount > strong')).toHaveText('13 mudu');
  await page.reload();
  await expect(page.locator('.stock-row .row-amount > strong')).toHaveText('13 mudu');
  await page.getByRole('button', { name: 'Adjust count' }).click();
  await page.getByLabel('New count (mudu)').fill('12.5');
  await page.getByRole('button', { name: 'Confirm new count' }).click();
  await expect(page.locator('.stock-row .row-amount > strong')).toHaveText('12.5 mudu');
  await page.goto('/settings');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export sales CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/doris-foods-sales.*\.csv/);
});

test('360px sale form stays usable and rejects missing required fields', async ({ page }) => {
  await readyOffline(page);
  await page.goto('/sales/new');
  await row(page, 0, { name: 'Garden eggs', quantity: '0.5', label: 'scoop', price: '250' });
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Customer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/sale-mobile.png', fullPage: true });
});

test('desktop overview renders without browser errors or overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await readyOffline(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
});
