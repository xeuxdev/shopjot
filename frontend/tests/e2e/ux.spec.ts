import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createStore } from '../helpers/store';

async function sale(page: Page, customer: string, paid = false, existing = false) {
  await page.goto('/sales/new');
  await page.getByLabel('Customer name').fill(customer);
  if (existing)
    await page
      .locator('.suggestions')
      .getByRole('button', { name: new RegExp(customer) })
      .click();
  await page.getByLabel('Item name').fill('Rice');
  await page.getByLabel('Unit / label').fill('bag');
  await page.getByLabel('Price per unit (₦)').fill('100');
  if (!paid) await page.getByRole('radio', { name: 'Credit / unpaid' }).check();
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.locator('.receipt-total strong')).toHaveText('₦100');
  return page.url();
}

test('existing customers can be selected with the keyboard', async ({ page }) => {
  await createStore(page);
  await sale(page, 'Amina');
  await page.goto('/sales/new');
  await page.getByLabel('Customer name').fill('Ami');
  await page.getByLabel('Customer name').press('Tab');
  const suggestion = page.locator('.suggestions').getByRole('button', { name: /Amina/ });
  await expect(suggestion).toBeFocused();
  await suggestion.press('Enter');
  await expect(page.getByLabel('Customer name')).toHaveValue('Amina');
  await expect(page.getByLabel('Item name')).toBeFocused();
});

test('draft recovery, field errors, recent goods and consecutive sales work on mobile', async ({
  page,
}) => {
  await createStore(page);
  await page.goto('/sales/new');
  await expect(page.locator('.mobile-checkout-bar')).toBeVisible();
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.getByLabel('Customer name')).toBeFocused();
  await expect(page.getByLabel('Customer name')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Customer name').fill('Amina');
  await page.getByLabel('Item name').fill('Tomatoes');
  await page.getByLabel('Unit / label').fill('basket');
  await page.getByLabel('Price per unit (₦)').fill('1500');
  await expect(page.locator('.draft-label')).toHaveText('Draft saved on this phone');
  await page.goto('/');
  await page.getByRole('link', { name: 'Resume draft' }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('Amina');
  await page.getByRole('button', { name: 'Review & save', exact: true }).click();
  await expect(page.locator('.sale-summary')).toBeFocused();
  await page.getByRole('button', { name: 'Save & record another', exact: true }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('');
  await expect(page.getByLabel('Customer name')).toBeFocused();
  await page.getByLabel('Customer name').fill('Bola');
  await page
    .locator('.recent-goods')
    .getByRole('button', { name: /Tomatoes/ })
    .click();
  await expect(page.getByLabel('Unit / label')).toHaveValue('basket');
  await expect(page.getByLabel('Price per unit (₦)')).toHaveValue('1500');
  await expect(page.locator('.toast')).toBeVisible();
  const toast = await page.locator('.toast').boundingBox();
  const checkout = await page.locator('.mobile-checkout-bar').boundingBox();
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(checkout!.y);
  await page.screenshot({ path: 'test-results/ux-sale-mobile.png' });
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep draft' }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('Bola');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Discard draft', exact: true })
    .click();
  await expect(page.getByLabel('Customer name')).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('Item name')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('customer payment previews the allocation and pays multiple selected sales', async ({
  page,
}) => {
  await createStore(page);
  await sale(page, 'Amina');
  await sale(page, 'Amina', false, true);
  await page.getByRole('link', { name: 'View customer ledger' }).click();
  await expect(page.locator('.customer-summary strong')).toHaveText('₦200');
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByLabel('Amount received (₦)').fill('150');
  await expect(
    page.getByRole('region', { name: 'Payment allocation' }).locator('.summary-row strong'),
  ).toHaveText(['₦100', '₦50', '₦50']);
  await page.screenshot({ path: 'test-results/ux-customer-payment.png' });
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual(
    [],
  );
  await page.getByRole('button', { name: 'Save customer payment' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.customer-summary strong')).toHaveText('₦50');
  await page.reload();
  await expect(page.locator('.customer-summary strong')).toHaveText('₦50');
});

test('correcting and voiding retain receipts and update balances and history', async ({ page }) => {
  await createStore(page);
  const original = await sale(page, 'Amina', true);
  await page.getByRole('button', { name: 'Correct sale', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Correct a sale', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.getByLabel('Reason for correction')).toBeFocused();
  await page.getByLabel('Reason for correction').fill('Wrong quantity');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByRole('radio', { name: 'Part payment' }).check();
  await page.getByLabel('Amount received (₦)').fill('100');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(page.locator('.receipt-total strong')).toHaveText('₦200');
  await expect(page.locator('.balance-due strong')).toHaveText('₦100');
  const replacement = page.url();
  await page.getByRole('link', { name: 'View original receipt', exact: true }).click();
  await expect(page).toHaveURL(original);
  await expect(page.getByText('Voided', { exact: true })).toBeVisible();
  await expect(page.getByText('Wrong quantity', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'View replacement receipt' }).click();
  await expect(page).toHaveURL(replacement);
  await page.getByRole('button', { name: 'Void sale', exact: true }).click();
  await page.getByLabel('Reason for voiding').fill('Goods returned');
  await page.getByRole('button', { name: 'Confirm void', exact: true }).click();
  await expect(page.getByText('Voided', { exact: true })).toBeVisible();
  await expect(page.locator('.balance-due strong')).toHaveText('₦0');
  await page.goto('/');
  await expect(page.locator('.sales-stat .stat-value')).toHaveText('₦0');
  await expect(page.locator('.stat .stat-value').first()).toHaveText('₦0');
});

test('a failed draft save is visible and can be retried without losing the form', async ({
  page,
}) => {
  await createStore(page);
  await page.goto('/sales/new');
  await expect(page.locator('.draft-label')).toHaveText('Draft saved on this phone');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'metadata' && value?.key === 'sale-draft')
        throw new DOMException('Storage temporarily unavailable', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    Object.assign(window, {
      restoreDraftWrites: () => {
        IDBObjectStore.prototype.put = original;
      },
    });
  });
  await page.getByLabel('Customer name').fill('Keep this customer');
  await expect(page.locator('.draft-label')).toContainText('Couldn’t save draft');
  await expect(page.getByLabel('Customer name')).toHaveValue('Keep this customer');
  await page.evaluate(() =>
    (window as unknown as { restoreDraftWrites: () => void }).restoreDraftWrites(),
  );
  await page.getByRole('button', { name: 'Retry draft save' }).click();
  await expect(page.locator('.draft-label')).toHaveText('Draft saved on this phone');
  await page.reload();
  await expect(page.getByLabel('Customer name')).toHaveValue('Keep this customer');
});
