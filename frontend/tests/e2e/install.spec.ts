import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createStore } from '../helpers/store';

test.beforeEach(async ({ page }) => {
  // Native OS dialogs are tested on phones; browser tests supply controlled install events.
  await page.addInitScript(() => {
    window.addEventListener(
      'beforeinstallprompt',
      (event) => {
        if (event.isTrusted) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  });
});

async function offerInstall(page: Page, outcome: 'accepted' | 'dismissed' | 'error' = 'dismissed') {
  return page.evaluate((result) => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        document.documentElement.dataset.installPrompts = String(
          Number(document.documentElement.dataset.installPrompts ?? 0) + 1,
        );
        if (result === 'error') throw new Error('Install unavailable');
        return { outcome: result };
      },
    });
    return !window.dispatchEvent(event);
  }, outcome);
}

test('install guide is available before setup and in the header on a small phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  const install = page.getByRole('button', { name: 'Install Shopjot', exact: true });
  await expect(install).toBeInViewport();
  await install.click();
  const guide = page.getByRole('dialog', { name: 'Install Shopjot' });
  await expect(guide.getByRole('heading', { name: 'iPhone or iPad' })).toBeVisible();
  await expect(guide.getByText('Add to Home Screen', { exact: true })).toBeVisible();
  await expect(guide.getByRole('heading', { name: 'Android' })).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/install-guide-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(guide).toHaveCount(0);
  await expect(install).toBeFocused();
  await createStore(page, 'A shop with a very long name '.repeat(5));
  await expect(install).toBeInViewport();
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Sales', exact: true })
    .click();
  await install.click();
  await expect(guide).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/install-header-mobile.png', fullPage: true });
});

test('native prompt survives setup and navigation, is used once, and handles installation', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('Store name', { exact: true })).toBeVisible();
  expect(await offerInstall(page)).toBe(true);
  await page.getByLabel('Store name', { exact: true }).fill('My store');
  await page.getByRole('button', { name: 'Create store & get started' }).click();
  await page
    .getByRole('navigation', { name: 'Mobile navigation' })
    .getByRole('link', { name: 'Sales', exact: true })
    .click();
  const install = page.getByRole('button', { name: 'Install Shopjot', exact: true });
  await install.click();
  await expect(page.locator('html')).toHaveAttribute('data-install-prompts', '1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A dismissed event cannot be prompted twice; the guide remains available instead.
  await install.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-install-prompts', '1');
  await page.getByRole('button', { name: 'Got it' }).click();
  await offerInstall(page, 'accepted');
  await install.click();
  await expect(page.locator('html')).toHaveAttribute('data-install-prompts', '2');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await expect(install).toHaveCount(0);
});

test('failed native prompts fall back to installation instructions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Store name', { exact: true })).toBeVisible();
  await offerInstall(page, 'error');
  await page.getByRole('button', { name: 'Install Shopjot', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Install Shopjot' })).toBeVisible();
});

for (const mode of ['standalone', 'ios'] as const) {
  test(`install button is hidden in ${mode} installed mode`, async ({ page }) => {
    await page.addInitScript((displayMode) => {
      if (displayMode === 'ios') {
        Object.defineProperty(navigator, 'standalone', { value: true });
      } else {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const media = original(query);
          if (query.includes('display-mode: standalone'))
            Object.defineProperty(media, 'matches', { value: true });
          return media;
        };
      }
    }, mode);
    await createStore(page);
    await expect(page.getByRole('button', { name: 'Install Shopjot', exact: true })).toHaveCount(0);
  });
}

test('production manifest and icons are available and the app can launch offline', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  const response = await page.request.get(manifestUrl!);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: '/',
    short_name: 'Shopjot',
    display: 'standalone',
    start_url: '/',
    scope: '/',
  });
  for (const icon of manifest.icons) {
    const asset = await page.request.get(icon.src);
    expect(asset.headers()['content-type']).toContain('image/png');
    expect(asset.ok()).toBe(true);
  }
  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  const asset = await page.request.get(appleIcon!);
  expect(asset.headers()['content-type']).toContain('image/png');
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
  await page.goto('/sales');
  await expect(page.getByLabel('Store name', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Install Shopjot', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Install Shopjot' })).toBeVisible();
});
