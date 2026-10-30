import { expect, test, type Page } from '@playwright/test';

async function mockPublicApi(page: Page) {
  // Same guest boot mocks as creation-flow.spec.ts: no MySQL, no live API.
  await page.route('**/api/auth/oidc/config', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' }),
  );
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHORIZED"}' }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }),
  );
  await page.route('**/api/generations**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }),
  );
  await page.route('**/api/orgs', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"items":[{"id":"personal-org","name":"个人工作空间","plan":"free","credits":0,"role":"owner"}]}',
    }),
  );
}

async function settleAndCapture(page: Page, heading: string, emptyHistory: string, emptyResult: string, name: string) {
  // The studio route is lazy-loaded; the first Vite transform can outlast the default 5s expect.
  const ready = { timeout: 60_000 };
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible(ready);
  await expect(page.getByText(emptyHistory, { exact: true })).toBeVisible(ready);
  await expect(page.getByText(emptyResult, { exact: true })).toBeVisible(ready);
  // Pin the faces installed by Playwright's Ubuntu browser dependencies so the
  // Linux baseline matches GitHub Actions after `playwright install --with-deps`.
  await page.addStyleTag({
    content: [
      '*, *::before, *::after {',
      '  animation: none !important;',
      '  transition: none !important;',
      '  caret-color: transparent !important;',
      '  font-family: "Liberation Sans", "Noto Color Emoji", "WenQuanYi Zen Hei", sans-serif !important;',
      '}',
    ].join('\n'),
  });
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
}

test.describe('video studio visual regression', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await mockPublicApi(page);
  });

  test('matches the Chinese video studio', async ({ page }) => {
    await page.goto('/video', { timeout: 90_000 });
    await settleAndCapture(page, '视频创作台', '暂无生成记录', '还没有生成视频', 'video-zh.png');
  });

  test('matches the English video studio', async ({ page }) => {
    await page.goto('/en/video', { timeout: 90_000 });
    await settleAndCapture(page, 'Video Studio', 'No generations yet', 'No video generated yet', 'video-en.png');
  });
});
