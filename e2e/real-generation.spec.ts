import { expect, test } from '@playwright/test';

/**
 * Opt-in API-backed browser journey.  The default browser suite stays hermetic
 * and fast; CI's service-backed E2E job enables this test after MySQL, Redis,
 * the API, and the embedded worker are ready.
 */
const runRealJourney = process.env.RUN_REAL_E2E === 'true';

test.describe('real generation journey', () => {
  test.skip(!runRealJourney, 'Set RUN_REAL_E2E=true with API, MySQL, Redis, and ffmpeg available');

  test('registers, creates a video, renders it, and deletes it', async ({ page }) => {
    // The built-in renderer writes a real MP4 and can take longer than the
    // default UI-test budget on a shared CI runner.
    test.setTimeout(150_000);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `browser-${suffix}@benchu.test`;
    const password = 'browser-e2e-password';

    await page.goto('/video');
    await page.getByRole('button', { name: '登录' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '注册', exact: true }).click();
    await dialog.getByLabel('邮箱').fill(email);
    await dialog.getByLabel('密码').fill(password);
    await dialog.getByRole('button', { name: '注册并登录' }).click();
    await expect(dialog).toBeHidden();

    await page.getByLabel('视频生成提示词').fill(`浏览器真实链路验证 ${suffix}：雨夜霓虹街道，镜头缓慢推进`);
    // A newly registered account is on the free tier (five-second cap).
    // The slider spans 2..15 seconds, so 5 seconds is 3/13 across its track.
    const durationSlider = page.locator('div.cursor-pointer.touch-none').last();
    const sliderBox = await durationSlider.boundingBox();
    if (!sliderBox) throw new Error('duration slider is not visible');
    await durationSlider.click({ position: { x: (sliderBox.width * 3) / 13, y: sliderBox.height / 2 } });
    await expect(page.getByText('5 s', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '开始生成' }).click();

    const result = page.getByRole('heading', { name: '生成结果' }).locator('..').locator('..');
    const video = result.locator('video');
    await expect(video).toHaveCount(1, { timeout: 120_000 });
    await expect(video).toHaveAttribute('src', /\/media\//);

    await result.getByRole('button', { name: '删除' }).click();
    await expect(video).toHaveCount(0);
    await expect(result.getByText('还没有生成视频')).toBeVisible();
  });
});
