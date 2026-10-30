import { expect, test, type Page } from '@playwright/test';

async function silenceGuestApi(page: Page) {
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
  await page.route('**/api/orgs', (route) => route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }));
}

async function expectEnglishMain(page: Page, title: string) {
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('main')).not.toContainText(/[\u4e00-\u9fff]/);
}

test('shows English titles for prompts, cinematography, and a tool page', async ({ page }) => {
  await silenceGuestApi(page);

  await page.goto('/en/prompts');
  await expectEnglishMain(page, 'Prompt Library');
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy prompt' }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search prompts' })).toBeVisible();
  await expect(page.getByText('cinematic shallow depth of field')).toBeVisible();

  await page.goto('/en/cinematography');
  await expectEnglishMain(page, 'Cinematography');
  await expect(page.getByRole('heading', { level: 2, name: 'Shot size', exact: true })).toBeVisible();
  await expect(page.getByText('Extreme wide', { exact: true })).toBeVisible();
  await expect(page.getByText('Sets the place and the scale', { exact: true })).toBeVisible();

  await page.goto('/en/clip');
  await expectEnglishMain(page, 'Idea to Video');
  await expect(page.getByRole('heading', { level: 2, name: 'Results', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start smart edit', exact: true })).toBeVisible();
  await expect(page.getByText('No results yet. Enter content and click "Start smart edit".')).toBeVisible();
});
