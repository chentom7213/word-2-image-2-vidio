import { defineConfig, devices } from '@playwright/test';

const baseURL = (process.env.COMPOSE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');

/**
 * Browser acceptance against the already-running production Compose stack.
 * Unlike the default Playwright config, this intentionally starts no Vite
 * server so nginx, built chunks, the /api proxy, and the real database are
 * exercised as one deployed system.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'compose-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'compose-chromium', use: { ...devices['Desktop Chrome'] } }],
});
