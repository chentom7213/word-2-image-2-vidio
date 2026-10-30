import { expect, test } from '@playwright/test';

test.describe('production Compose browser acceptance', () => {
  test('serves SPA deep links and reaches protected pages through the real API', async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `compose-browser-${suffix}@benchu.test`;
    const displayName = email.slice(0, email.indexOf('@'));
    const password = 'compose-browser-e2e-password';
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const ready = await request.get('/api/ready');
    expect(ready.ok()).toBeTruthy();
    expect(await ready.json()).toMatchObject({ ok: true });
    expect(ready.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(ready.headers()['x-content-type-options']).toBe('nosniff');

    const metrics = await request.get('/api/metrics');
    expect(metrics.status()).toBe(403);
    expect(metrics.headers()['content-security-policy']).toContain("default-src 'self'");

    const root = await request.get('/');
    expect(root.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(root.headers()['x-content-type-options']).toBe('nosniff');
    expect(root.headers()['x-frame-options']).toBe('DENY');
    expect(root.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(root.headers()['cache-control']).toContain('no-store');
    const html = await root.text();
    expect(html).toContain('src="/theme-init.js"');
    expect(html).not.toContain('localStorage.getItem');
    const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    expect(assetPath).toBeTruthy();
    const asset = await request.get(assetPath!);
    expect(asset.ok()).toBeTruthy();
    expect(asset.headers()['cache-control']).toContain('immutable');
    expect(asset.headers()['content-security-policy']).toContain("default-src 'self'");

    // Opening a nested route directly verifies nginx's SPA fallback rather
    // than relying on an in-app navigation that never reaches the web server.
    await page.goto('/team');
    await expect(page.getByRole('heading', { name: '团队与 API' })).toHaveCount(0);
    await expect(page.getByText('登录后管理团队与 API Key')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: '登录' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '注册', exact: true }).click();
    await dialog.getByLabel('邮箱').fill(email);
    await dialog.getByLabel('密码').fill(password);
    await dialog.getByRole('button', { name: '注册并登录' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: displayName, exact: true })).toBeVisible();

    await expect(page.getByRole('heading', { name: '团队与 API' })).toBeVisible();
    await expect(page.getByLabel('成员邮箱')).toBeVisible();
    await expect(page.getByLabel('API Key 名称')).toBeVisible();

    await page.getByRole('link', { name: '资产库' }).click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(page.getByRole('heading', { name: '资产库' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^图片/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '上传素材' })).toBeVisible();

    await page.getByRole('link', { name: '套餐与充值' }).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('heading', { name: '套餐与充值' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '订阅套餐' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '订单记录' })).toBeVisible();

    await page.getByRole('link', { name: '运营看板' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: '运营看板' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '运营指标' })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
