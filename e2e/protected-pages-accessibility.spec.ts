import { expect, test, type Page } from '@playwright/test';

const user = {
  id: 'e2e-admin',
  email: 'admin@example.com',
  displayName: '测试管理员',
  credits: 12345,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function login(page: Page, path: string) {
  await page.goto(path);
  await page.getByRole('banner').getByRole('button', { name: '登录' }).click();
  await page.getByLabel('邮箱').fill(user.email);
  await page.getByLabel('密码').fill('not-a-real-password');
  await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();
  await expect(page.getByRole('button', { name: user.displayName })).toBeVisible();
}

test.describe('protected page accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/oidc/config', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' }),
    );
    await page.route('**/api/auth/refresh', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHORIZED"}' }),
    );
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'e2e-token', user }) }),
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
        body: JSON.stringify({
          items: [{ id: 'org-1', name: '测试工作空间', plan: 'enterprise', credits: 12345, role: 'owner' }],
        }),
      }),
    );
    await page.route('**/api/admin/billing/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"ok":true,"counts":{"creditMismatch":0,"paidWithoutWebhook":0},"creditMismatch":[],"paidWithoutWebhook":[]}',
      }),
    );
  });

  test('labels team forms and restores focus after closing a modal', async ({ page }) => {
    await page.route('**/api/orgs/org-1/members', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              userId: user.id,
              email: user.email,
              displayName: user.displayName,
              role: 'owner',
              createdAt: user.createdAt,
            },
            {
              userId: 'member-2',
              email: 'editor@example.com',
              displayName: '协作者',
              role: 'editor',
              createdAt: user.createdAt,
            },
          ],
        }),
      }),
    );
    let keyPosts = 0;
    await page.route('**/api/api-keys', (route) => {
      if (route.request().method() === 'POST') keyPosts += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'key-1',
              name: 'ci',
              prefix: 'bk_live_ab',
              scopes: ['generate:image'],
              rateLimit: 60,
              expiresAt: '2026-10-26 00:00:00',
              lastUsedAt: null,
              revokedAt: null,
              createdAt: '2026-10-26 00:00:00',
            },
          ],
        }),
      });
    });
    await login(page, '/team');

    await expect(page.getByLabel('成员邮箱')).toBeVisible();
    await expect(page.getByLabel('成员角色')).toHaveValue('editor');
    await expect(page.getByLabel('协作者的角色')).toHaveValue('editor');
    await expect(page.getByLabel('API Key 名称')).toBeVisible();
    await expect(page.getByRole('button', { name: '移除成员' })).toBeVisible();
    await expect(page.getByText('每分钟 60 次', { exact: false })).toBeVisible();
    const keyExpiry = new Date('2026-10-26T00:00:00Z');
    const pad = (n: number) => n.toString().padStart(2, '0');
    const keyClock = `${keyExpiry.getFullYear()}-${pad(keyExpiry.getMonth() + 1)}-${pad(keyExpiry.getDate())} ${pad(keyExpiry.getHours())}:${pad(keyExpiry.getMinutes())}`;
    await expect(page.getByText(`到期 ${keyClock}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'generate:image' })).toHaveAttribute('aria-pressed', 'true');
    const createKey = page.getByRole('button', { name: '创建', exact: true });
    await expect(createKey).toBeEnabled();
    await page.getByRole('button', { name: 'generate:image', exact: true }).click();
    await page.getByRole('button', { name: 'generate:video', exact: true }).click();
    await expect(createKey).toBeDisabled();
    await page.getByLabel('API Key 名称').fill('empty-scopes');
    expect(keyPosts).toBe(0);

    const trigger = page.getByRole('button', { name: '新建组织' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '新建组织' });
    const orgName = dialog.getByLabel('组织名称');
    await expect(orgName).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeFocused();
    await orgName.fill('持续输入不会丢失焦点');
    await expect(orgName).toHaveValue('持续输入不会丢失焦点');
    await expect(orgName).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.getByRole('combobox', { name: '语言' }).selectOption('en');
    await expect(page).toHaveURL(/\/en\/team$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Team & API' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
    await expect(page.getByLabel('Member email')).toBeVisible();
    await expect(page.getByLabel('Member role')).toHaveValue('editor');
    await expect(page.getByLabel('Role for 协作者')).toHaveValue('editor');
    await expect(page.getByLabel('API key name')).toBeVisible();

    const englishTrigger = page.getByRole('button', { name: 'New organization' });
    await englishTrigger.click();
    const englishDialog = page.getByRole('dialog', { name: 'New organization' });
    await expect(englishDialog.getByLabel('Organization name')).toBeVisible();
    await expect(englishDialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(englishDialog).toBeHidden();
    await expect(englishTrigger).toBeFocused();
  });

  test('hides member role changes from an organization admin', async ({ page }) => {
    await page.route('**/api/orgs', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ id: 'org-1', name: '测试工作空间', plan: 'enterprise', credits: 12345, role: 'admin' }],
        }),
      }),
    );
    await page.route('**/api/orgs/org-1/members', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              userId: 'owner-1',
              email: 'owner@example.com',
              displayName: '所有者',
              role: 'owner',
              createdAt: user.createdAt,
            },
            {
              userId: 'member-2',
              email: 'editor@example.com',
              displayName: '协作者',
              role: 'editor',
              createdAt: user.createdAt,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/api-keys', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }),
    );
    await login(page, '/team');
    await expect(page.getByLabel('成员邮箱')).toBeVisible();
    await expect(page.getByRole('button', { name: '移除成员' })).toBeVisible();
    await expect(page.getByLabel('成员角色')).toHaveValue('editor');
    await expect(page.getByLabel('协作者的角色')).toHaveCount(0);
  });

  test('makes asset tabs and preview controls keyboard-addressable', async ({ page }) => {
    let directUploadUrl = '';
    let signedBody: Record<string, unknown> | null = null;
    let confirmBody: Record<string, unknown> | null = null;
    await page.route('**/api/assets*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/api/assets') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'asset-1',
              kind: 'image',
              name: 'sample.png',
              url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
              size: 42,
            },
          ],
        }),
      });
    });
    await page.route('**/api/assets/sign', async (route) => {
      signedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadUrl: 'https://storage.example.test/uploads/e2e-admin/large-sample.png?signature=test',
          objectKey: 'uploads/e2e-admin/large-sample.png',
          headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
          kind: 'image',
          method: 'PUT',
          confirmToken: 'signed-confirm-token-for-browser-regression',
        }),
      });
    });
    await page.route('**/api/assets/upload-capabilities', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          maxBytes: 50 * 1024 * 1024,
          directSupported: true,
          directRecommended: true,
          thresholdBytes: 5 * 1024 * 1024,
        }),
      }),
    );
    await page.route('https://storage.example.test/**', async (route) => {
      directUploadUrl = route.request().url();
      await route.fulfill({ status: 200, body: '' });
    });
    await page.route('**/api/assets/confirm', async (route) => {
      confirmBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          item: {
            id: 'asset-direct',
            kind: 'image',
            name: 'large-sample.png',
            url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
            size: 5 * 1024 * 1024,
          },
        }),
      });
    });
    await login(page, '/assets');

    const imageTab = page.getByRole('tab', { name: '图片 1' });
    await expect(imageTab).toHaveAttribute('aria-selected', 'true');
    await imageTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '视频 0' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');

    const preview = page.getByRole('button', { name: '预览素材 sample.png' });
    const remove = page.getByRole('button', { name: '删除素材 sample.png' });
    await remove.focus();
    await expect(remove).toBeFocused();
    await expect(remove).toHaveCSS('opacity', '1');
    await preview.click();
    const dialog = page.getByRole('dialog', { name: '预览素材 sample.png' });
    const close = dialog.getByRole('button', { name: '关闭素材预览' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(preview).toBeFocused();

    await page.getByRole('combobox', { name: '语言' }).selectOption('en');
    await expect(page).toHaveURL(/\/en\/assets$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Images 1' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Videos 0' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Audio 0' })).toBeVisible();
    const englishPreview = page.getByRole('button', { name: 'Preview asset sample.png' });
    await expect(page.getByRole('button', { name: 'Delete asset sample.png' })).toBeVisible();
    await englishPreview.click();
    const englishDialog = page.getByRole('dialog', { name: 'Preview asset sample.png' });
    await expect(englishDialog.getByRole('button', { name: 'Close asset preview' })).toBeFocused();
    await page.keyboard.press('Escape');

    await page.getByLabel('Choose asset files').setInputFiles({
      name: 'large-sample.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(5 * 1024 * 1024),
    });
    await expect.poll(() => directUploadUrl).toContain('https://storage.example.test/uploads/');
    expect(signedBody).toMatchObject({ filename: 'large-sample.png', mime: 'image/png', size: 5 * 1024 * 1024 });
    expect(confirmBody).toEqual({ confirmToken: 'signed-confirm-token-for-browser-regression' });
  });

  test('localizes billing catalogue and order status in the active session', async ({ page }) => {
    const plan = {
      id: 'free',
      name: 'Free',
      priceCents: 0,
      monthlyCredits: 100,
      maxConcurrent: 1,
      maxDuration: 8,
      rpm: 10,
      features: {},
      sortWeight: 1,
    };
    await page.route('**/api/billing/catalogue', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          plans: [plan],
          packs: [
            {
              id: 'credits-1000',
              name: 'Starter credits',
              credits: 1000,
              priceCents: 990,
              bonus: 100,
              sortWeight: 1,
            },
          ],
          gateway: { provider: 'stripe', configured: true, mock: false },
        }),
      }),
    );
    await page.route('**/api/billing/subscription', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ plan, activeTasks: 0, concurrencyLeft: 1, planId: 'free', planExpiresAt: null }),
      }),
    );
    await page.route('**/api/billing/orders*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/api/billing/orders') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'order-12345678',
              kind: 'credits',
              skuId: 'credits-1000',
              skuName: 'Starter credits',
              amountCents: 990,
              credits: 1100,
              status: 'paid',
              provider: 'stripe',
              paidAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              createdAt: Date.now(),
            },
          ],
        }),
      });
    });
    await login(page, '/billing');

    await expect(page.getByRole('heading', { name: '套餐与充值' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '订阅套餐' })).toBeVisible();
    await expect(page.getByText('已支付', { exact: true })).toBeVisible();

    await page.getByRole('combobox', { name: '语言' }).selectOption('en');
    await expect(page).toHaveURL(/\/en\/billing$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Plans & Credits' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Subscription plans' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Buy credits' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Order history' })).toBeVisible();
    await expect(page.getByText('Paid', { exact: true })).toBeVisible();
    await expect(page.getByText('1 concurrent tasks', { exact: true })).toBeVisible();
    await expect(page.getByText('Includes 100 bonus credits', { exact: true })).toBeVisible();
  });

  test('shows watermark copy for free and professional plans', async ({ page }) => {
    const freePlan = {
      id: 'free',
      name: '免费版',
      priceCents: 0,
      monthlyCredits: 1000,
      maxConcurrent: 1,
      maxDuration: 5,
      rpm: 20,
      features: { watermark: true },
      sortWeight: 0,
    };
    const proPlan = {
      id: 'pro',
      name: '专业版',
      priceCents: 9900,
      monthlyCredits: 20000,
      maxConcurrent: 4,
      maxDuration: 10,
      rpm: 120,
      features: { watermark: false },
      sortWeight: 10,
    };
    await page.route('**/api/billing/catalogue*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET' || path !== '/api/billing/catalogue') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          plans: [freePlan, proPlan],
          packs: [],
          gateway: { provider: 'mock', configured: true, mock: true },
        }),
      });
    });
    await page.route('**/api/billing/subscription*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET' || path !== '/api/billing/subscription') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          plan: freePlan,
          activeTasks: 0,
          concurrencyLeft: 1,
          planId: 'free',
          planExpiresAt: null,
        }),
      });
    });
    await page.route('**/api/billing/orders*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET' || path !== '/api/billing/orders') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    });
    await login(page, '/billing');

    await expect(page.getByText('生成结果带水印', { exact: true })).toBeVisible();
    await expect(page.getByText('生成结果不带水印', { exact: true })).toBeVisible();
  });

  test('exposes admin tabs and model status actions by name', async ({ page }) => {
    await page.route('**/api/admin/stats', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: '30d',
          tasks: {
            total: 1,
            queued: 0,
            running: 0,
            done: 1,
            failed: 0,
            successRate: 1,
            creditsCharged: 10,
            creditsRefunded: 0,
          },
          credits: { granted: 100, spent: 10, activeUsers: 1 },
          topErrors: [],
          topModels: [],
        }),
      }),
    );
    await page.route('**/api/admin/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"ok":true,"balanceDrift":[],"doubleCharged":[],"unrefundedFailures":[]}',
      }),
    );
    await page.route('**/api/admin/audit**', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[],"nextCursor":null}' }),
    );
    await page.route('**/api/admin/orders*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"items":[],"totals":{"paidCount":0,"revenueCents":0,"creditsSold":0},"nextCursor":null}',
      }),
    );
    await page.route('**/api/admin/models', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'model-1',
              provider: 'mock',
              displayName: '测试模型',
              kind: 'video',
              priceUnit: 'per_second',
              priceAmount: 10,
              maxDuration: 10,
              providerModel: 'model-1',
              enabled: true,
              sortWeight: 1,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/admin/billing/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          counts: { creditMismatch: 150, paidWithoutWebhook: 0 },
          creditMismatch: [],
          paidWithoutWebhook: [],
        }),
      }),
    );
    await login(page, '/admin');
    await expect(page.getByText('订单入账对账')).toBeVisible();
    await expect(page.getByText('150 笔订单入账不符')).toBeVisible();
    await expect(page.getByText('0 笔已支付订单没有回调')).toHaveCount(0);

    const opsTab = page.getByRole('tab', { name: '运营指标' });
    await expect(opsTab).toHaveAttribute('aria-selected', 'true');
    await opsTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '模型与定价' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: '测试模型：下架模型' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('shows English names for admin tabs', async ({ page }) => {
    await page.route('**/api/admin/stats', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: '30d',
          tasks: {
            total: 1,
            queued: 0,
            running: 0,
            done: 1,
            failed: 0,
            successRate: 1,
            creditsCharged: 10,
            creditsRefunded: 0,
          },
          credits: { granted: 100, spent: 10, activeUsers: 1 },
          topErrors: [],
          topModels: [],
        }),
      }),
    );
    await page.route('**/api/admin/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"ok":true,"balanceDrift":[],"doubleCharged":[],"unrefundedFailures":[]}',
      }),
    );
    await page.route('**/api/admin/audit**', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[],"nextCursor":null}' }),
    );
    await page.route('**/api/admin/orders*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"items":[],"totals":{"paidCount":0,"revenueCents":0,"creditsSold":0},"nextCursor":null}',
      }),
    );
    await page.route('**/api/admin/models', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'model-1',
              provider: 'mock',
              displayName: '测试模型',
              kind: 'video',
              priceUnit: 'per_second',
              priceAmount: 10,
              maxDuration: 10,
              providerModel: 'model-1',
              enabled: true,
              sortWeight: 1,
            },
          ],
        }),
      }),
    );

    await page.goto('/en/admin');
    await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('button', { name: user.displayName })).toBeVisible();

    await expect(page).toHaveURL(/\/en\/admin$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Operations', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Operations metrics' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Models and pricing' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Audit log' })).toBeVisible();
  });

  test('loads earlier audit rows with the id cursor', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/admin/stats', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: '30d',
          tasks: { total: 0, queued: 0, running: 0, done: 0, failed: 0, successRate: null, creditsCharged: 0, creditsRefunded: 0 },
          credits: { granted: 0, spent: 0, activeUsers: 0 },
          topErrors: [],
          topModels: [],
        }),
      }),
    );
    await page.route('**/api/admin/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"ok":true,"balanceDrift":[],"doubleCharged":[],"unrefundedFailures":[]}',
      }),
    );
    await page.route('**/api/admin/models', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }),
    );
    await page.route('**/api/admin/orders*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"items":[],"totals":{"paidCount":0,"revenueCents":0,"creditsSold":0},"nextCursor":null}',
      }),
    );
    await page.route('**/api/admin/audit**', (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const before = url.searchParams.get('before');
      if (before === '51') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ id: 50, userId: null, action: 'older.audit', target: null, ip: null, ua: null, meta: null, createdAt: '2026-10-01 00:00:00' }],
            nextCursor: null,
          }),
        });
      }
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: 100 - index,
        userId: null,
        action: `audit.${100 - index}`,
        target: null,
        ip: null,
        ua: null,
        meta: null,
        createdAt: '2026-10-26 00:00:00',
      }));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items, nextCursor: '51' }),
      });
    });

    await login(page, '/admin');
    await page.getByRole('tab', { name: '审计日志' }).click();
    await expect(page.getByText('audit.100')).toBeVisible();
    await page.getByRole('button', { name: '查看更早记录' }).click();
    await expect(page.getByText('older.audit')).toBeVisible();
    expect(requests.some((query) => query.includes('before=51'))).toBe(true);
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('older.audit')).toBeVisible();
    const auditInstant = new Date('2026-10-26T00:00:00Z');
    const pad = (n: number) => n.toString().padStart(2, '0');
    const auditClock = `${auditInstant.getFullYear()}-${pad(auditInstant.getMonth() + 1)}-${pad(auditInstant.getDate())} ${pad(auditInstant.getHours())}:${pad(auditInstant.getMinutes())}`;
    await expect(page.getByText(auditClock).first()).toBeVisible();
    await expect(page.getByText('2026-10-26 00:00:00')).toHaveCount(0);
  });

  test('loads earlier organization orders with the history cursor', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/admin/stats', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          window: '30d',
          tasks: { total: 0, queued: 0, running: 0, done: 0, failed: 0, successRate: null, creditsCharged: 0, creditsRefunded: 0 },
          credits: { granted: 0, spent: 0, activeUsers: 0 },
          topErrors: [],
          topModels: [],
        }),
      }),
    );
    await page.route('**/api/admin/reconcile', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: '{"ok":true,"balanceDrift":[],"doubleCharged":[],"unrefundedFailures":[]}',
      }),
    );
    await page.route('**/api/admin/models', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[]}' }),
    );
    await page.route('**/api/admin/audit**', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"items":[],"nextCursor":null}' }),
    );
    await page.route('**/api/admin/orders*', (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const totals = { paidCount: 51, revenueCents: 5100, creditsSold: 510 };
      if (url.searchParams.get('beforeId') === 'order-49') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 'order-old',
                userId: 'user-old',
                kind: 'credits',
                skuId: 'pack',
                skuName: '更早订单',
                amountCents: 100,
                credits: 10,
                status: 'paid',
                provider: 'mock',
                paidAt: 1,
                expiresAt: 2,
                createdAt: 1,
              },
            ],
            totals,
            nextCursor: null,
          }),
        });
      }
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: `order-${index}`,
        userId: 'user-1',
        kind: 'credits',
        skuId: 'pack',
        skuName: `订单 ${index}`,
        amountCents: 100,
        credits: 10,
        status: 'paid',
        provider: 'mock',
        paidAt: 1,
        expiresAt: 2,
        createdAt: 1_700_000_000_000 - index,
      }));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          totals,
          nextCursor: { createdAt: '2026-10-01 00:00:00.000', id: 'order-49' },
        }),
      });
    });

    await login(page, '/admin');
    await expect(page.getByText('订单 0')).toBeVisible();
    await page.getByRole('button', { name: '查看更早记录' }).click();
    await expect(page.getByText('更早订单')).toBeVisible();
    expect(requests.some((query) => query.includes('beforeId=order-49'))).toBe(true);
  });

  test('loads earlier assets with the history cursor', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/assets*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/assets') return route.fallback();
      requests.push(url.search);
      if (url.searchParams.get('beforeId') === 'asset-49') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 'asset-old',
                kind: 'image',
                name: '更早素材.png',
                url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
                size: 10,
                createdAt: 1,
              },
            ],
            nextCursor: null,
          }),
        });
      }
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: `asset-${index}`,
        kind: 'image',
        name: `素材 ${index}.png`,
        url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        size: 10,
        createdAt: 1_700_000_000_000 - index,
      }));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          nextCursor: { createdAt: '2026-10-01 00:00:00.000', id: 'asset-49' },
        }),
      });
    });

    await login(page, '/assets');
    await expect(page.getByRole('heading', { name: '资产库' })).toBeVisible();
    await page.getByRole('button', { name: '查看更早记录' }).click();
    await expect(page.getByText('更早素材.png')).toBeVisible();
    expect(requests.some((query) => query.includes('beforeId=asset-49'))).toBe(true);
  });

  test('loads earlier orders and credit rows with the history cursor', async ({ page }) => {
    const orderQueries: string[] = [];
    const creditQueries: string[] = [];
    const plan = {
      id: 'free',
      name: 'Free',
      priceCents: 0,
      monthlyCredits: 100,
      maxConcurrent: 1,
      maxDuration: 8,
      rpm: 10,
      features: {},
      sortWeight: 1,
    };
    await page.route('**/api/billing/catalogue', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ plans: [plan], packs: [], gateway: { provider: 'mock', configured: true, mock: true } }),
      }),
    );
    await page.route('**/api/billing/subscription', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ plan, activeTasks: 0, concurrencyLeft: 1, planId: 'free', planExpiresAt: null }),
      }),
    );
    await page.route('**/api/billing/orders*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/billing/orders') return route.fallback();
      orderQueries.push(url.search);
      if (url.searchParams.get('beforeId') === 'order-49') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              {
                id: 'order-old',
                kind: 'credits',
                skuId: 'pack',
                skuName: '更早订单',
                amountCents: 100,
                credits: 10,
                status: 'paid',
                provider: 'mock',
                paidAt: 1,
                expiresAt: 2,
                createdAt: 1,
              },
            ],
            nextCursor: null,
          }),
        });
      }
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: `order-${index}`,
        kind: 'credits',
        skuId: 'pack',
        skuName: `订单 ${index}`,
        amountCents: 100,
        credits: 10,
        status: 'paid',
        provider: 'mock',
        paidAt: 1,
        expiresAt: 2,
        createdAt: 1_700_000_000_000 - index,
      }));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          nextCursor: { createdAt: '2026-10-01 00:00:00.000', id: 'order-49' },
        }),
      });
    });
    await page.route('**/api/credits/summary', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ balance: 12345, gained: 9000, spent: 100, refunded: 7 }),
      }),
    );
    await page.route('**/api/credits/transactions*', (route) => {
      const url = new URL(route.request().url());
      creditQueries.push(url.search);
      if (url.searchParams.get('beforeId') === 'tx-49') {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ id: 'tx-old', delta: -1, balanceAfter: 1, reason: '更早流水', refId: null, createdAt: 1 }],
            nextCursor: null,
          }),
        });
      }
      const items = Array.from({ length: 50 }, (_, index) => ({
        id: `tx-${index}`,
        delta: 1,
        balanceAfter: 50 - index,
        reason: `流水 ${index}`,
        refId: null,
        createdAt: 1_700_000_000_000 - index,
      }));
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          nextCursor: { createdAt: '2026-10-01 00:00:00.000', id: 'tx-49' },
        }),
      });
    });
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user }) }),
    );
    await page.route('**/api/auth/sessions*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== '/api/auth/sessions') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          items: [
            {
              id: 'session-1',
              createdAt: '2026-10-26 00:00:00',
              ip: '203.0.113.9',
              userAgent: 'Browser',
              current: true,
            },
          ],
          nextCursor: null,
        }),
      });
    });

    await login(page, '/billing');
    await expect(page.getByText('订单 0')).toBeVisible();
    await page.getByRole('button', { name: '查看更早记录' }).click();
    await expect(page.getByText('更早订单')).toBeVisible();
    expect(orderQueries.some((query) => query.includes('beforeId=order-49'))).toBe(true);

    await page.getByRole('button', { name: '查看积分明细' }).click();
    const dialog = page.getByRole('dialog', { name: '账户 · 积分明细' });
    await expect(dialog.getByText('流水 0')).toBeVisible();
    await expect(dialog.getByText('累计获得 +9,000')).toBeVisible();
    await expect(dialog.getByText('累计消耗 -100')).toBeVisible();
    await expect(dialog.getByText('累计退款 7')).toBeVisible();
    const signedInAt = new Date('2026-10-26T00:00:00Z');
    const pad = (n: number) => n.toString().padStart(2, '0');
    const signedInClock = `${signedInAt.getFullYear()}-${pad(signedInAt.getMonth() + 1)}-${pad(signedInAt.getDate())} ${pad(signedInAt.getHours())}:${pad(signedInAt.getMinutes())}`;
    await expect(dialog.getByText(signedInClock, { exact: false })).toBeVisible();
    await expect(dialog.getByText('203.0.113.9', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: '查看更早记录' }).click();
    await expect(dialog.getByText('更早流水')).toBeVisible();
    expect(creditQueries.some((query) => query.includes('beforeId=tx-49'))).toBe(true);
  });
});
