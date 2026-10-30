import { expect, test, type Page } from '@playwright/test';

const user = {
  id: 'canvas-user',
  email: 'canvas@example.com',
  displayName: '画布测试员',
  credits: 1000,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function login(page: Page) {
  await page.goto('/canvas');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByLabel('邮箱').fill(user.email);
  await page.getByLabel('密码').fill('not-a-real-password');
  await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();
  await expect(page.getByRole('button', { name: user.displayName })).toBeVisible();
}

test('persists canvas text, viewport, and real asset bindings', async ({ page }) => {
  let stored: {
    id: string;
    name: string;
    version: number;
    nodes: Array<Record<string, unknown>>;
    viewport: { zoom: number; x: number; y: number };
    updatedAt: number;
  } | null = null;

  await page.route('**/api/auth/oidc/config', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' }),
  );
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHORIZED"}' }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'canvas-token', user }) }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user }) }),
  );
  await page.route('**/api/orgs', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'org-canvas', name: '画布工作空间', plan: 'free', credits: 1000, role: 'owner' }],
      }),
    }),
  );
  await page.route('**/api/assets', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '123e4567-e89b-42d3-a456-426614174000',
            kind: 'image',
            name: 'sample.png',
            url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
            size: 42,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/canvas', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: stored }) });
      return;
    }
    const input = route.request().postDataJSON() as {
      version: number;
      nodes: Array<Record<string, unknown>>;
      viewport: { zoom: number; x: number; y: number };
    };
    expect(input.version).toBe(stored?.version ?? 0);
    stored = {
      id: 'canvas-1',
      name: '我的画布',
      version: input.version + 1,
      nodes: input.nodes,
      viewport: input.viewport,
      updatedAt: Date.now(),
    };
    await route.fulfill({
      status: input.version === 0 ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ item: stored }),
    });
  });

  await login(page);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '文本' }).click();
  const textNode = page.getByLabel('画布文本节点');
  await textNode.fill('这段文字会自动保存');
  await expect.poll(() => stored?.nodes[0]?.text).toBe('这段文字会自动保存');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '图片', exact: true }).click();
  await page.getByRole('button', { name: '添加素材 sample.png' }).click();
  await expect(page.getByRole('img', { name: 'sample.png' })).toBeVisible();
  await expect
    .poll(() => stored?.nodes.some((node) => node.assetId === '123e4567-e89b-42d3-a456-426614174000'))
    .toBe(true);

  await page.reload();
  await expect(page.getByLabel('画布文本节点')).toHaveValue('这段文字会自动保存');
  await expect(page.getByRole('img', { name: 'sample.png' })).toBeVisible();

  await page.getByRole('combobox', { name: '语言' }).selectOption('en');
  await expect(page).toHaveURL(/\/en\/canvas$/);
  await expect(page.getByRole('button', { name: 'Text' })).toBeVisible();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

test('reloads the server canvas after a version conflict', async ({ page }) => {
  const stored = {
    id: 'canvas-1',
    name: '我的画布',
    version: 2,
    nodes: [
      {
        id: 'text-1',
        type: 'text',
        x: 10,
        y: 10,
        w: 260,
        h: 150,
        text: '服务器上的文字',
      },
    ],
    viewport: { zoom: 1, x: 0, y: 0 },
    updatedAt: Date.now(),
  };

  await page.route('**/api/auth/oidc/config', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{"enabled":false}' }),
  );
  await page.route('**/api/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHORIZED"}' }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ token: 'canvas-token', user }) }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user }) }),
  );
  await page.route('**/api/orgs', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ id: 'org-canvas', name: '画布工作空间', plan: 'free', credits: 1000, role: 'owner' }],
      }),
    }),
  );
  await page.route('**/api/assets', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route('**/api/canvas', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: stored }) });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'CANVAS_VERSION_CONFLICT', message: '画布已在其他页面更新，请刷新后重试' }),
    });
  });

  await login(page);
  const textNode = page.getByLabel('画布文本节点');
  await expect(textNode).toHaveValue('服务器上的文字');
  await textNode.fill('这次没写上的本地改动');
  await expect(page.getByText('画布已在其他页面更新，请刷新')).toBeVisible();
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(textNode).toHaveValue('服务器上的文字');
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
});
