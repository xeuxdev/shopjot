import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createStore } from '../helpers/store';

test.use({ timezoneId: 'America/New_York' });

async function seedSales(page: Page) {
  await createStore(page);
  await page.clock.setFixedTime(new Date('2026-11-21T12:00:00Z'));
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('doris-foods-ledger');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const identity = await new Promise<{ storeId: string }>((resolve, reject) => {
        const request = database.transaction('metadata').objectStore('metadata').get('identity');
        request.onsuccess = () => resolve(request.result.value);
        request.onerror = () => reject(request.error);
      });
      const scoped = { storeId: identity.storeId, createdAt: '2026-11-21T12:00:00Z' };
      const entries = [
        {
          id: 'today-paid',
          occurredAt: '2026-11-21T10:00:00Z',
          totalKobo: 100050,
          status: 'active',
          customerId: 'amina',
        },
        {
          id: 'today-unpaid',
          occurredAt: '2026-11-20T23:00:00Z',
          totalKobo: 200000,
          status: 'active',
          customerId: 'bola',
        },
        {
          id: 'today-void',
          occurredAt: '2026-11-21T09:00:00Z',
          totalKobo: 900000,
          status: 'voided',
          customerId: 'amina',
        },
        {
          id: 'yesterday',
          occurredAt: '2026-11-20T22:59:59Z',
          totalKobo: 400000,
          status: 'active',
          customerId: 'amina',
        },
        {
          id: 'week-start',
          occurredAt: '2026-11-14T23:00:00Z',
          totalKobo: 800000,
          status: 'active',
          customerId: 'bola',
        },
        {
          id: 'month-start',
          occurredAt: '2026-10-31T23:00:00Z',
          totalKobo: 1600000,
          status: 'active',
          customerId: 'amina',
        },
      ];
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction(
          ['customers', 'sales', 'saleItems', 'payments'],
          'readwrite',
        );
        for (const [id, name] of [
          ['amina', 'Amina'],
          ['bola', 'Bola'],
        ])
          tx.objectStore('customers').put({
            ...scoped,
            id,
            name,
            normalizedName: name.toLowerCase(),
            updatedAt: scoped.createdAt,
            phone: null,
          });
        for (const entry of entries) {
          tx.objectStore('sales').put({ ...scoped, ...entry });
          tx.objectStore('saleItems').put({
            ...scoped,
            id: `item-${entry.id}`,
            saleId: entry.id,
            position: 0,
            name: 'Rice',
            quantity: '1',
            quantityLabel: 'bag',
            unitPriceKobo: entry.totalKobo,
            lineTotalKobo: entry.totalKobo,
            productUnitId: null,
          });
        }
        tx.objectStore('payments').put({
          ...scoped,
          id: 'payment',
          saleId: 'today-paid',
          amountKobo: 100050,
          receivedAt: scoped.createdAt,
          reversalOf: null,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      database.close();
    }
  });
  await page.goto('/sales');
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦31,000.50');
}

test('date shortcuts, daily totals and combined filters work offline', async ({
  page,
  context,
}) => {
  await seedSales(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  const periods = page.getByRole('group', { name: 'Filter by sale dates' });
  await periods.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.sales-day')).toHaveCount(1);
  await expect(page.locator('.sales-day-total strong')).toHaveText('₦3,000.50');
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦3,000.50');
  await expect(page.locator('.sales-day .ledger-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Unpaid', exact: true }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦2,000');
  await page.getByRole('button', { name: 'Voided', exact: true }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦0');
  await expect(page.locator('.sales-day .ledger-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'All sales', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search customer or goods…' }).fill('Bola');
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦2,000');
  await page.getByRole('textbox', { name: 'Search customer or goods…' }).fill('');
  await periods.getByRole('button', { name: 'Yesterday', exact: true }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦4,000');
  await periods.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦15,000.50');
  await periods.getByRole('button', { name: 'This month', exact: true }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦31,000.50');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(periods.getByRole('button', { name: 'All dates' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a single picked date shows only that day and its total', async ({ page }) => {
  await seedSales(page);
  await page.getByRole('button', { name: 'Pick a date', exact: true }).click();
  const date = page.getByLabel('Sale date', { exact: true });
  await expect(date).toHaveValue('2026-11-21');
  await date.fill('2026-11-20');
  await expect(page.locator('.sales-day')).toHaveCount(1);
  await expect(page.locator('.sales-day .ledger-row')).toHaveCount(1);
  await expect(page.locator('.sales-day-total strong')).toHaveText('₦4,000');
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦4,000');
  await page.reload();
  await expect(date).toHaveValue('2026-11-20');
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦4,000');
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/sales-single-date-320.png', fullPage: true });
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  await date.fill('');
  await expect(page.getByRole('heading', { name: 'Pick a sale date' })).toBeVisible();
  await expect(page.locator('.sales-totals')).toHaveCount(0);
  await date.fill('2026-11-22');
  await expect(page.getByRole('heading', { name: 'No matching sales' })).toBeVisible();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦0');
});

test('custom ranges are inclusive, survive reload and receipt navigation, and explain invalid or empty ranges', async ({
  page,
}) => {
  await seedSales(page);
  await page.getByRole('button', { name: 'Custom dates', exact: true }).click();
  await page.getByLabel('From date', { exact: true }).fill('2026-11-20');
  await page.getByLabel('To date', { exact: true }).fill('2026-11-21');
  await expect(page.locator('.sales-day-total strong')).toHaveText(['₦3,000.50', '₦4,000']);
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦7,000.50');
  await page.reload();
  await expect(page.getByLabel('From date', { exact: true })).toHaveValue('2026-11-20');
  await page.locator('.sales-day .ledger-row').first().click();
  await expect(page.locator('.receipt-total strong')).toHaveText('₦1,000.50');
  await page.goBack();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦7,000.50');
  await page.getByLabel('From date', { exact: true }).fill('2026-11-22');
  await expect(page.getByRole('alert')).toContainText('Choose a to date');
  await expect(page.locator('.sales-totals')).toHaveCount(0);
  await page.getByLabel('To date', { exact: true }).fill('2026-11-22');
  await expect(page.getByRole('heading', { name: 'No matching sales' })).toBeVisible();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦0');
  await page.locator('.empty-state').getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.sales-total-main > strong')).toHaveText('₦31,000.50');
});

test('sales filters and totals remain accessible and fit mobile and desktop', async ({ page }) => {
  await seedSales(page);
  await page.getByRole('button', { name: 'Custom dates', exact: true }).click();
  await page.getByLabel('From date', { exact: true }).fill('2026-11-01');
  await page.getByLabel('To date', { exact: true }).fill('2026-11-21');
  for (const width of [320, 360, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/sales-filters-${width}.png`, fullPage: true });
  }
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual(
    [],
  );
});
