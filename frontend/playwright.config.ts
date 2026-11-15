import { defineConfig, devices } from '@playwright/test';
const externalBaseUrl = process.env.E2E_BASE_URL;
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: externalBaseUrl ?? 'http://127.0.0.1:4173',
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'npm run preview',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
