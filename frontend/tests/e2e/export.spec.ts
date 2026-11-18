import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createStore } from '../helpers/store';

test('exports transactions as PDF and readable naira CSV while offline', async ({
  page,
  context,
}) => {
  await createStore(page, 'Nnéka’s Corner Shop');
  await page.clock.setFixedTime(new Date('2026-11-18T12:40:43.000Z'));
  await page.goto('/sales/new');
  await page.getByLabel('Customer name').fill('Chịka');
  await page.getByLabel('Item name').fill('Rice');
  await page.getByLabel('Quantity', { exact: true }).fill('1');
  await page.getByLabel('Unit / label').fill('bag');
  await page.getByLabel('Price per unit (₦)').fill('12450.50');
  await page.getByRole('radio', { name: 'Part payment' }).check();
  await page.getByLabel('Amount received (₦)').fill('450.50');
  await page.getByRole('button', { name: 'Save sale', exact: true }).click();
  await expect(page.locator('.balance-due strong')).toHaveText('₦12,000');
  await page.goto('/settings');
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
  await page.reload();
  const pdfReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export transactions PDF' }).click();
  const pdf = await pdfReady;
  expect(pdf.suggestedFilename()).toMatch(/^shopjot-transactions-.*\.pdf$/);
  const bytes = await readFile((await pdf.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.toString('latin1')).toContain('%%EOF');
  await pdf.saveAs('test-results/transactions-report.pdf');
  const csvReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export sales CSV' }).click();
  const csv = await csvReady;
  const text = await readFile((await csv.path())!, 'utf8');
  expect(text).toContain('"18/11/2026, 01:40:43 pm","12450.50","12000.00"');
  const customersReady = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export customers CSV' }).click();
  const customers = await customersReady;
  expect(await readFile((await customers.path())!, 'utf8')).toContain('"Chịka","","12000.00"');
});
