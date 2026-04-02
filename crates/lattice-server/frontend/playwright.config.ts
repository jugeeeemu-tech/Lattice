import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173';
const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL ||
  (process.env.CI ? 'chrome' : undefined);
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    channel: browserChannel as 'chrome' | undefined,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: useExternalServer
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        url: baseURL,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
