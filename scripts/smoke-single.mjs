import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180_000);
const password = process.env.SMOKE_PASSWORD || 'single-machine-smoke-password';
const email = process.env.SMOKE_EMAIL || `smoke-${Date.now()}@benchu.test`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

async function waitForReady() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await json('/api/health');
      if (health?.ok) return health;
      lastError = new Error(`health ok=${String(health?.ok)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(2_000);
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${lastError?.message || 'unknown'}`);
}

async function main() {
  console.log(`▶ 单机部署冒烟：${baseUrl}`);
  const health = await waitForReady();
  console.log(`✔ API/DB/Redis 就绪（queue=${health.queue?.mode || 'unknown'}）`);

  const registered = await json('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const token = registered?.token;
  if (!token) throw new Error('注册响应缺少 access token');
  const auth = { authorization: `Bearer ${token}` };
  const authJson = { ...auth, 'content-type': 'application/json' };
  console.log(`✔ 注册与鉴权通过（${email}）`);

  const models = await json('/api/models?kind=video');
  const model = (models?.items || []).find((item) => item.id === 'seedance-mini') || models?.items?.[0];
  if (!model) throw new Error('视频模型目录为空');
  console.log(`✔ 模型目录可用（${model.id}）`);

  const created = await json('/api/generations', {
    method: 'POST',
    headers: { ...authJson, 'idempotency-key': `single-machine-smoke-${randomUUID()}` },
    body: JSON.stringify({
      type: 'video',
      prompt: '单机部署冒烟测试：蓝色光点缓慢穿过夜空',
      modelId: model.id,
      resolution: '480p',
      width: 640,
      height: 360,
      duration: 3,
      count: 1,
    }),
  });
  const taskId = created?.item?.id;
  if (!taskId) throw new Error('创建任务响应缺少 task id');

  const deadline = Date.now() + timeoutMs;
  let task = created.item;
  while (!['done', 'failed'].includes(task.status) && Date.now() < deadline) {
    await sleep(1_000);
    task = (await json(`/api/generations/${taskId}`, { headers: auth })).item;
    process.stdout.write(`\r  渲染进度 ${String(task.progress || 0).padStart(3)}%`);
  }
  process.stdout.write('\n');
  if (task.status !== 'done') {
    throw new Error(`生成任务未完成：status=${task.status}, error=${task.errorCode || 'unknown'}`);
  }

  const outputs = await json(`/api/generations/${taskId}/outputs`, { headers: auth });
  const output = outputs?.items?.[0];
  if (!output?.url) throw new Error('任务完成但没有产物 URL');
  const mediaUrl = new URL(output.url, baseUrl);
  const media = await fetch(mediaUrl, { headers: { Range: 'bytes=0-31' } });
  if (![200, 206].includes(media.status)) throw new Error(`产物读取失败：HTTP ${media.status}`);
  const bytes = new Uint8Array(await media.arrayBuffer());
  if (bytes.length === 0) throw new Error('产物响应为空');
  console.log(`✔ Worker/ffmpeg/持久存储/签名媒体链路通过（task=${taskId}, HTTP ${media.status}）`);
  const removed = await json(`/api/generations/${taskId}`, { method: 'DELETE', headers: auth });
  if (!removed?.ok || Number(removed.cleanupFailures || 0) > 0) {
    throw new Error(`冒烟产物清理失败：${JSON.stringify(removed)}`);
  }
  const afterDelete = await fetch(mediaUrl);
  if (afterDelete.status !== 404) throw new Error(`删除后产物仍可读取：HTTP ${afterDelete.status}`);
  console.log('✔ 任务记录与物理产物清理通过');
  console.log('✅ 单机部署冒烟通过');
}

main().catch((error) => {
  console.error(`❌ 单机部署冒烟失败：${error.message || error}`);
  process.exit(1);
});
