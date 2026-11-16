import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createStore } from '../helpers/store';

for (const path of ['/', '/sales/new', '/settings']) {
  test(`accessible labels, structure and contrast at ${path}`, async ({ page }) => {
    await createStore(page);
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('.loading-text')).toHaveCount(0);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        description: v.description,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    ).toEqual([]);
  });
}

test('desktop overview has accessible contrast and structure', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createStore(page);
  await expect(page.locator('h1')).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  ).toEqual([]);
});
