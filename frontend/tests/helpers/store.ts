import { expect, type Page } from '@playwright/test';

export async function createStore(page: Page, name = 'Mama Chika’s shop') {
  await page.goto('/');
  await page.getByLabel('Store name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create store & get started' }).click();
  await expect(page.getByRole('heading', { name: 'Your shop, at a glance.' })).toBeVisible();
}
