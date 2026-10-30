import { defineConfig, devices } from '@playwright/test';

/** Browser-level smoke coverage for the public creation flow. */
export default defineConfig({
  testDir: './e2e',
  testIgnore: 'compose-smoke.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:5186',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5186',
    url: 'http://127.0.0.1:5186/video',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
