import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe('public creation flow', () => {
  test.beforeEach(async ({ page }) => {
    // Public browser smoke tests deliberately do not depend on MySQL/Redis.
    // Route the boot-time guest requests so a stopped API is not mistaken for
    // a UI failure, while model data still exercises the offline fallback.
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
  });

  test('redirects home to the video studio and exposes named creation controls', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/video$/);
    await expect(page.getByRole('heading', { name: '视频创作台' })).toBeVisible();
    await expect(page.getByLabel('视频生成提示词')).toBeVisible();
    await expect(page.getByRole('button', { name: '上传参考图' })).toBeVisible();
    const duration = page.getByRole('slider', { name: '视频时长' });
    await expect(duration).toHaveAttribute('aria-valuenow', '6');
    await duration.focus();
    await page.keyboard.press('ArrowRight');
    await expect(duration).toHaveAttribute('aria-valuenow', '7');
    await page.keyboard.press('ArrowLeft');
    await expect(duration).toHaveAttribute('aria-valuenow', '6');
    await expect(page.getByRole('button', { name: '开始生成' })).toBeDisabled();
  });

  test('clamps the visible video duration to five seconds after login', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'duration-token',
          user: { id: 'duration-user', email: 'duration@example.com', credits: 1000 },
        }),
      });
    });
    await page.route('**/api/billing/subscription*', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.pathname !== '/api/billing/subscription') {
        return route.fallback();
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          plan: {
            id: 'free',
            name: '免费版',
            priceCents: 0,
            monthlyCredits: 1000,
            maxConcurrent: 1,
            maxDuration: 5,
            rpm: 20,
            features: {},
            sortWeight: 0,
          },
          activeTasks: 0,
          concurrencyLeft: 1,
          planId: 'free',
          planExpiresAt: 1_893_456_000_000,
        }),
      });
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('duration@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();

    const duration = page.getByRole('slider', { name: '视频时长' }).filter({ visible: true }).first();
    await expect(duration).toHaveAttribute('aria-valuemax', '5');
    await expect(duration).toHaveAttribute('aria-valuenow', '5');
    await expect(page.locator('body')).not.toContainText(/\b6 s\b|6\s*秒/);
  });

  test('opens and dismisses the login dialog with the keyboard', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'e2e-token',
          user: { id: 'e2e-user', email: 'creator@example.com', displayName: '创作测试用户', credits: 12345 },
        }),
      }),
    );
    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '登录', exact: true }).first()).toBeVisible();
    await expect(dialog.getByLabel('邮箱')).toBeVisible();
    await expect(dialog.getByLabel('密码')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('creator@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await dialog.getByRole('button', { name: '登录', exact: true }).last().click();

    await expect(page.getByRole('button', { name: '创作测试用户' })).toBeVisible();
    await expect(page.getByRole('button', { name: /12,345/ })).toBeVisible();
    await expect(page.getByLabel('切换工作空间')).toHaveValue('personal-org');
    await page.getByLabel('视频生成提示词').fill('雨夜霓虹街道，镜头缓慢推进');
    await expect(page.getByRole('button', { name: '开始生成' })).toBeEnabled();
  });

  test('renders the image studio with keyboard-addressable prompt and upload controls', async ({ page }) => {
    await page.goto('/image');

    await expect(page.getByRole('heading', { name: '生图工作台' })).toBeVisible();
    await expect(page.getByLabel('图片生成提示词')).toBeVisible();
    await expect(page.getByRole('button', { name: '上传参考图' })).toBeVisible();
  });

  test('appends an English quality suffix when improving an image prompt', async ({ page }) => {
    await page.goto('/en/image');
    await page.getByRole('button', { name: 'Improve', exact: true }).click();
    await expect(page.getByLabel('Image generation prompt')).toHaveValue(
      'ultra-fine detail, cinematic lighting, considered composition',
    );
  });

  test('shows English sample prompts in the image prompt library', async ({ page }) => {
    const sample =
      'Slow push-in. The subject shifts from soft focus to sharp, neon bokeh in the background, cinematic shallow depth of field, cool color grade.';
    await page.goto('/en/image');
    await page.getByRole('button', { name: 'Prompt library', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prompt library' });
    await expect(dialog.getByText('镜头缓缓推近')).toHaveCount(0);
    await dialog.getByText(sample).click();
    await expect(page.getByLabel('Image generation prompt')).toHaveValue(sample);
  });

  test('shows English sample prompts in the video prompt library', async ({ page }) => {
    await page.goto('/en/video');
    await page.getByRole('button', { name: 'Browse prompt library', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Prompt library' });
    await expect(dialog.getByText('镜头缓缓推近')).toHaveCount(0);
    await dialog.getByText('The camera slowly pushes in.', { exact: false }).click();
    await expect(page.getByLabel('Video generation prompt')).toHaveValue(/The camera slowly pushes in/);
  });

  test('localizes the video studio heading and generate action', async ({ page }) => {
    await page.goto('/en/video');

    await expect(page.getByRole('heading', { name: 'Video Studio', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse Agent panel', exact: true })).toBeVisible();
    await expect(page.getByText('Hi, I am Xinghui Agent. Happy to help!', { exact: false })).toBeVisible();
  });

  test('keeps navigation inside the selected locale prefix', async ({ page }) => {
    await page.goto('/en/video');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('link', { name: 'Video Studio' })).toBeVisible();
    await expect(page.getByLabel('Language')).toHaveValue('en');
    await page.getByRole('link', { name: 'Image Studio' }).click();
    await expect(page).toHaveURL(/\/en\/image$/);
  });

  test('names the video play control', async ({ page }) => {
    await page.route('**/api/generations**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'video-1',
              type: 'video',
              prompt: '播放按钮',
              modelId: 'seedance-2',
              modelName: 'Seedance 2.0',
              resolution: '720p',
              width: 1280,
              height: 720,
              duration: 6,
              count: 1,
              status: 'done',
              progress: 100,
              seed: 'seed-1',
              credits: 10,
              createdAt: Date.now(),
              outputs: [{ id: 'out-1', kind: 'video', url: 'https://example.test/clip.mp4', mime: 'video/mp4' }],
            },
          ],
        }),
      }),
    );
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'play-token',
          user: { id: 'play-user', email: 'play@example.com', credits: 20 },
        }),
      }),
    );
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('play@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();
    await page.getByRole('button', { name: '播放按钮 Seedance 2.0 · 6s' }).click();
    const seek = page.getByRole('slider', { name: '播放进度' });
    await seek.scrollIntoViewIfNeeded();
    await expect(seek).toBeVisible();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    const fullscreen = page.getByRole('button', { name: '全屏' });
    await fullscreen.focus();
    await expect(fullscreen).toBeVisible();
  });

  test('virtualizes a large generation history after login', async ({ page }) => {
    const now = Date.now();
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `history-${i}`,
      type: 'video',
      prompt: `虚拟记录 ${i}`,
      modelId: 'seedance-2',
      modelName: 'Seedance 2.0',
      resolution: '720p',
      width: 1280,
      height: 720,
      duration: 6,
      count: 1,
      status: 'done',
      progress: 100,
      seed: `seed-${i}`,
      resultUrl: null,
      posterUrl: null,
      outputs: [],
      credits: 330,
      error: null,
      createdAt: now - i * 1000,
      finishedAt: now - i * 1000,
      refImages: [],
      refVideos: [],
      refAudios: [],
    }));
    await page.route('**/api/generations**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items }) }),
    );
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'history-token',
          user: { id: 'history-user', email: 'history@example.com', credits: 50000 },
        }),
      }),
    );

    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('history@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();

    await expect(page.getByRole('button', { name: '虚拟记录 0 Seedance 2.0 · 6s' })).toBeVisible();
    expect(await page.getByRole('button', { name: /虚拟记录/ }).count()).toBeLessThan(60);
  });

  test('virtualizes a large image result list after login', async ({ page }) => {
    const now = Date.now();
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: `image-history-${i}`,
      type: 'image',
      prompt: `生图记录 ${i}`,
      modelId: 'flux',
      modelName: 'Flux',
      resolution: '1:1',
      width: 1024,
      height: 1024,
      duration: 0,
      count: 1,
      status: 'done',
      progress: 100,
      seed: `seed-${i}`,
      resultUrl: null,
      posterUrl: null,
      outputs: [],
      credits: 20,
      error: null,
      createdAt: now - i * 1000,
      finishedAt: now - i * 1000,
      refImages: [],
      refVideos: [],
      refAudios: [],
    }));
    await page.route('**/api/generations**', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items }) }),
    );
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'image-history-token',
          user: { id: 'image-history-user', email: 'images@example.com', credits: 50000 },
        }),
      }),
    );

    await page.goto('/image');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('images@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();

    await expect(page.getByText('生图记录 0', { exact: true })).toBeVisible();
    expect(await page.getByText(/生图记录/).count()).toBeLessThan(40);
  });

  test('opens a completed image in a dialog and dismisses it with Escape', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'cat-token',
          user: { id: 'cat-user', email: 'cat@example.com', credits: 8 },
        }),
      });
    });
    await page.route('**/api/generations**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.pathname !== '/api/generations') {
        return route.fallback();
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'cat-1',
              type: 'image',
              prompt: '一只猫',
              modelId: 'nano-banana',
              modelName: 'nano-banana',
              width: 512,
              height: 512,
              duration: 0,
              count: 1,
              status: 'done',
              progress: 100,
              seed: 'e2e',
              credits: 1,
              createdAt: Date.now(),
              outputs: [
                {
                  id: 'cat-output-1',
                  kind: 'image',
                  url: '/media/cat.png',
                  mime: 'image/png',
                  width: 512,
                  height: 512,
                  duration: null,
                  bytes: 128,
                  watermarked: false,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/image');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('cat@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();

    await page.getByAltText('一只猫 #1', { exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('keeps a small reference image when a file exceeds 50MB', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-ref-'));
    const tiny = join(dir, 'tiny.png');
    const huge = join(dir, 'huge.png');
    writeFileSync(tiny, 'tiny');
    writeFileSync(huge, Buffer.from([0]));
    truncateSync(huge, 50 * 1024 * 1024 + 1);
    try {
      await page.goto('/video');
      await page.getByLabel('选择参考图文件').setInputFiles([tiny, huge]);

      await expect(page.getByText('单个文件不能超过 50MB')).toBeVisible();
      await expect(page.getByRole('img', { name: 'tiny.png', exact: true })).toBeVisible();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shows reference video and audio upload buttons before login', async ({ page }) => {
    await page.goto('/video');

    await expect(page.getByRole('button', { name: '上传参考视频' })).toBeVisible();
    await expect(page.getByRole('button', { name: '上传参考音频' })).toBeVisible();
  });

  test('hides reference video and audio uploads after login for an image-only model', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'refs-token',
          user: { id: 'refs-user', email: 'refs@example.com', credits: 1000 },
        }),
      });
    });
    await page.route('**/api/models**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.pathname !== '/api/models') {
        return route.fallback();
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'seedance-2',
              name: 'Seedance 2.0',
              kind: 'video',
              priceLabel: '55积分/秒起',
              priceAmount: 55,
              priceUnit: 'per_second',
              tag: null,
              refs: ['image'],
              durations: [6],
              provider: 'builtin',
              maxDuration: 12,
            },
          ],
        }),
      });
    });

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('邮箱').fill('refs@example.com');
    await page.getByLabel('密码').fill('not-a-real-password');
    await page.getByRole('dialog').getByRole('button', { name: '登录', exact: true }).last().click();

    await expect(page.getByRole('button', { name: '上传参考图' })).toBeVisible();
    await expect(page.getByRole('button', { name: '上传参考视频' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '上传参考音频' })).toHaveCount(0);
  });
});
