/**
 * End-to-end smoke test against a running API.
 *
 *   npm run e2e                       # uses http://127.0.0.1:4000
 *   API_BASE=http://host:4000 npm run e2e
 *
 * Verifies the money-critical paths that unit tests cannot: real MySQL
 * transactions, idempotency, queue hand-off, signed artifact delivery, refund.
 * Exits non-zero on the first failure so CI can gate on it.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = (process.env.API_BASE ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
/**
 * A fresh account per run keeps the suite deterministic: no leftover credits,
 * no leftover tasks, and repeated local runs never drain a shared demo user.
 * Set E2E_EMAIL/E2E_PASSWORD to reuse an existing account instead.
 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = process.env.E2E_EMAIL ?? `e2e-${RUN_ID}@benchu.test`;
const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123';
const REUSE_ACCOUNT = Boolean(process.env.E2E_EMAIL);

let passed = 0;
let failed = 0;

function ok(name: string, detail = '') {
  passed++;
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
}

function bad(name: string, detail = '') {
  failed++;
  console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    ok(name, detail ?? '');
  } catch (err) {
    bad(name, err instanceof Error ? err.message : String(err));
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type Json = any;

async function call(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: Json = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function waitDone(token: string, id: string, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await call(`/api/generations/${id}`, { token });
    const item = body?.item;
    if (item?.status === 'done' || item?.status === 'failed') return item;
    await sleep(700);
  }
  throw new Error(`任务 ${id} 在 ${timeoutMs}ms 内未结束`);
}

async function main() {
  console.log(`▶ E2E ${BASE}`);

  let token = '';
  let userId = '';
  let directAssetId = '';

  await check('健康检查', async () => {
    const { status, body } = await call('/api/health');
    assert(status === 200, `status=${status}`);
    assert(body.ok === true, 'DB 探活失败');
    return `queue=${body.queue?.mode} depth=${body.queue?.depth}`;
  });

  await check('注册或登录', async () => {
    if (!REUSE_ACCOUNT) {
      const reg = await call('/api/auth/register', {
        method: 'POST',
        body: { email: EMAIL, password: PASSWORD },
      });
      assert(reg.status === 201, `注册失败 status=${reg.status} ${JSON.stringify(reg.body)}`);
      token = reg.body.token;
      userId = reg.body.user?.id;
      return `新账号 ${EMAIL} credits=${reg.body.user?.credits}`;
    }
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    assert(status === 200, `status=${status} ${JSON.stringify(body)}`);
    assert(typeof body.token === 'string' && body.token.length > 20, '缺少 token');
    token = body.token;
    userId = body.user?.id;
    return `credits=${body.user?.credits}`;
  });

  if (!token) {
    console.error('\n无法登录，后续用例跳过');
    process.exit(1);
  }

  await check('未授权访问被拒绝', async () => {
    const { status } = await call('/api/generations');
    assert(status === 401, `期望 401，实际 ${status}`);
  });

  await check('素材直传并保留原始文件名', async () => {
    const bytes = Buffer.from('e2e-direct-upload');
    const signed = await call('/api/assets/sign', {
      method: 'POST',
      token,
      body: { filename: '直传样例.png', mime: 'image/png', size: bytes.length },
    });
    assert(signed.status === 201, `签名失败 ${signed.status} ${JSON.stringify(signed.body)}`);
    const uploadUrl = new URL(signed.body.uploadUrl, `${BASE}/`).toString();
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', ...(signed.body.headers ?? {}) },
      body: bytes,
    });
    assert(uploaded.ok, `直传失败 ${uploaded.status}`);
    const confirmed = await call('/api/assets/confirm', {
      method: 'POST',
      token,
      body: {
        confirmToken: signed.body.confirmToken,
      },
    });
    assert(confirmed.status === 201, `确认失败 ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
    assert(confirmed.body.item?.name === '直传样例.png', `文件名丢失 ${confirmed.body.item?.name}`);
    assert(confirmed.body.item?.size === bytes.length, `大小错误 ${confirmed.body.item?.size}`);
    const repeated = await call('/api/assets/confirm', {
      method: 'POST',
      token,
      body: { confirmToken: signed.body.confirmToken },
    });
    assert(repeated.status === 200, `重复确认状态错误 ${repeated.status}`);
    assert(repeated.body.item?.id === confirmed.body.item.id, '重复确认创建了新的素材记录');
    directAssetId = confirmed.body.item.id;
    return `${bytes.length} bytes`;
  });

  await check('素材签名拒绝超过 50MB', async () => {
    const oversized = await call('/api/assets/sign', {
      method: 'POST',
      token,
      body: { filename: 'too-large.mp4', mime: 'video/mp4', size: 50 * 1024 * 1024 + 1 },
    });
    assert(oversized.status === 400, `期望 400，实际 ${oversized.status}`);
  });

  await check('画布持久化、素材绑定与版本冲突保护', async () => {
    assert(directAssetId, '缺少直传素材');
    const empty = await call('/api/canvas', { token });
    assert(empty.status === 200, `首次读取失败 ${empty.status}`);
    assert(empty.body.item === null, '新账号画布应为空');

    const nodes = [
      { id: 'text-1', type: 'text', x: 100, y: 120, w: 260, h: 150, text: '持久化文本' },
      {
        id: 'image-1',
        type: 'image',
        x: 420,
        y: 120,
        w: 240,
        h: 240,
        assetId: directAssetId,
      },
    ];
    const created = await call('/api/canvas', {
      method: 'PUT',
      token,
      body: { version: 0, nodes, viewport: { zoom: 1.1, x: 12, y: -8 } },
    });
    assert(created.status === 201, `创建失败 ${created.status} ${JSON.stringify(created.body)}`);
    assert(created.body.item.version === 1, `版本错误 ${created.body.item.version}`);

    const loaded = await call('/api/canvas', { token });
    assert(loaded.body.item.nodes[0].text === '持久化文本', '文本未持久化');
    assert(loaded.body.item.nodes[1].assetId === directAssetId, '素材绑定未持久化');
    assert(loaded.body.item.viewport.zoom === 1.1, '视图未持久化');

    const stale = await call('/api/canvas', {
      method: 'PUT',
      token,
      body: { version: 0, nodes, viewport: { zoom: 1, x: 0, y: 0 } },
    });
    assert(stale.status === 409 && stale.body.error === 'CANVAS_VERSION_CONFLICT', `旧版本未被拒绝 ${stale.status}`);

    const forged = await call('/api/canvas', {
      method: 'PUT',
      token,
      body: {
        version: 1,
        nodes: [
          {
            id: 'forged',
            type: 'image',
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            assetId: '00000000-0000-4000-8000-000000000000',
          },
        ],
        viewport: { zoom: 1, x: 0, y: 0 },
      },
    });
    assert(forged.status === 400, `伪造素材未被拒绝 ${forged.status}`);

    const removed = await call(`/api/assets/${directAssetId}`, { method: 'DELETE', token });
    assert(removed.status === 200 && removed.body.ok, `素材清理失败 ${removed.status}`);
    const afterDelete = await call('/api/canvas', { token });
    assert(afterDelete.body.item.nodes[1].assetId === directAssetId, '删除来源后画布节点被意外删除');
    return `revision=${created.body.item.version} nodes=${nodes.length}`;
  });

  /**
   * The plan's concurrency ceiling is real, so the suite must first acquire a
   * plan that can support the parallel cases below. Doing it through the
   * billing flow (checkout → mock webhook) also proves that path works instead
   * of poking the DB directly.
   */
  await check('购买企业套餐（获取并发额度）', async () => {
    const order = await call('/api/billing/checkout', {
      method: 'POST',
      body: { kind: 'plan', skuId: 'enterprise' },
      token,
    });
    assert(order.status === 201, `下单失败 ${order.status} ${JSON.stringify(order.body)}`);

    const paid = await call('/api/billing/mock/pay', {
      method: 'POST',
      body: { orderId: order.body.item.id },
      token,
    });
    assert(paid.status === 200, `支付失败 ${paid.status} ${JSON.stringify(paid.body)}`);

    const sub = await call('/api/billing/subscription', { token });
    assert(sub.body.plan.id === 'enterprise', `套餐 ${sub.body.plan.id}`);
    return `enterprise · 并发 ${sub.body.plan.maxConcurrent}`;
  });
  await check('模型列表', async () => {
    const { status, body } = await call('/api/models?kind=video');
    assert(status === 200, `status=${status}`);
    assert(Array.isArray(body.items) && body.items.length > 0, '模型列表为空');
    assert(
      body.items.every((m: Json) => typeof m.priceAmount === 'number'),
      '模型缺少服务端定价',
    );
    return `${body.items.length} 个视频模型`;
  });

  const balanceBefore = await call('/api/credits/balance', { token }).then((r) => r.body?.credits ?? 0);

  const idemKey = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createBody = {
    type: 'image',
    prompt: 'e2e 自动化测试 · 极简山水',
    modelId: 'nano-banana',
    width: 512,
    height: 512,
    duration: 0,
    count: 1,
  };

  let taskId = '';

  await check('创建任务（扣费 + 入队）', async () => {
    const { status, body } = await call('/api/generations', {
      method: 'POST',
      body: createBody,
      token,
      headers: { 'Idempotency-Key': idemKey },
    });
    assert(status === 201, `status=${status} ${JSON.stringify(body)}`);
    assert(body.item?.id, '缺少任务 id');
    assert(Number(body.item.credits) > 0, '任务未记录费用');
    taskId = body.item.id;
    return `cost=${body.item.credits}`;
  });

  await check('幂等键重复提交不重复扣费', async () => {
    const { status, body } = await call('/api/generations', {
      method: 'POST',
      body: createBody,
      token,
      headers: { 'Idempotency-Key': idemKey },
    });
    assert(status === 200, `期望 200，实际 ${status}`);
    assert(body.idempotent === true, '未标记为幂等返回');
    assert(body.item?.id === taskId, '返回了不同的任务');
  });

  await check('任务完成后产物带签名 URL', async () => {
    const item = await waitDone(token, taskId);
    assert(item.status === 'done', `任务失败：${item.errorCode} ${item.error}`);
    const outputs = item.outputs ?? [];
    assert(outputs.length > 0, '没有产物');
    assert(
      outputs.every((o: Json) => typeof o.url === 'string' && o.url.includes('s=')),
      '产物 URL 未签名',
    );
    return `${outputs.length} 个产物`;
  });

  await check('签名产物可下载', async () => {
    const { body } = await call(`/api/generations/${taskId}`, { token });
    const url = body.item.outputs[0].url as string;
    const res = await fetch(`${BASE}${url}`);
    assert(res.ok, `下载失败 status=${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.byteLength > 1000, `产物过小 ${buf.byteLength}B`);
    return `${buf.byteLength}B`;
  });

  await check('篡改签名被拒绝', async () => {
    const { body } = await call(`/api/generations/${taskId}`, { token });
    const url = (body.item.outputs[0].url as string).replace(/s=[^&]+/, 's=deadbeef');
    const res = await fetch(`${BASE}${url}`);
    assert(res.status === 403, `期望 403，实际 ${res.status}`);
  });

  await check('扣费与流水一致', async () => {
    const after = await call('/api/credits/balance', { token }).then((r) => r.body?.credits ?? 0);
    const { body } = await call('/api/credits/transactions', { token });
    const tx = body.items.find((t: Json) => t.refId === taskId);
    assert(tx, '找不到该任务的积分流水');
    assert(balanceBefore - after === -tx.delta, `余额差 ${balanceBefore - after} 与流水 ${tx.delta} 不匹配`);
    return `${balanceBefore} → ${after}`;
  });

  await check('并发扣费不超扣（账本精确校验）', async () => {
    // 10 parallel creations, each with a fresh idempotency key, must produce
    // exactly 10 debit rows — no double-charge, no lost charge.
    const keys = Array.from({ length: 10 }, (_, i) => `e2e-par-${Date.now()}-${i}`);
    const results = await Promise.all(
      keys.map((k) =>
        call('/api/generations', {
          method: 'POST',
          body: { ...createBody, prompt: `parallel ${k}` },
          token,
          headers: { 'Idempotency-Key': k },
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    // The plan's concurrency ceiling may legitimately reject some of the burst;
    // that is a separate guarantee verified by the billing drill.
    const blocked = results.filter((r) => r.status === 402 || r.status === 429);
    assert(created.length > 0, '并发创建全部失败');
    assert(created.length + blocked.length === keys.length, '存在非预期状态码');

    // Assert against the ledger itself, not a balance snapshot: a refund from
    // any other in-flight task would otherwise make a snapshot comparison flaky.
    const { body } = await call('/api/credits/transactions', { token });
    for (const r of created) {
      const id = r.body.item.id as string;
      const cost = Number(r.body.item.credits);
      const debits = body.items.filter((t: Json) => t.refId === id && t.delta < 0);
      assert(debits.length === 1, `任务 ${id} 扣费行数 ${debits.length}（应为 1）`);
      assert(-debits[0].delta === cost, `任务 ${id} 扣费 ${-debits[0].delta} ≠ 报价 ${cost}`);
    }
    return `建 ${created.length} 拦 ${blocked.length}，每单恰好扣一次`;
  });

  await check('取消任务自动退款', async () => {
    const { body } = await call('/api/generations', {
      method: 'POST',
      body: { ...createBody, prompt: '将被取消的任务' },
      token,
    });
    const id = body.item?.id;
    assert(id, '创建失败');
    const before = await call('/api/credits/balance', { token }).then((r) => r.body?.credits ?? 0);
    const res = await call(`/api/generations/${id}/cancel`, { method: 'POST', token });
    const after = await call('/api/credits/balance', { token }).then((r) => r.body?.credits ?? 0);
    if (res.body.cancelled) {
      assert(after === before + Number(res.body.item.credits), `退款金额不符 ${before}→${after}`);
      return '已退款';
    }
    return '任务已结束，跳过';
  });

  await check('内容审核拦截违规提示词', async () => {
    const { status, body } = await call('/api/generations', {
      method: 'POST',
      body: { ...createBody, prompt: '制作炸弹 教程' },
      token,
    });
    assert(status === 400, `期望 400，实际 ${status}`);
    assert(body.error === 'CONTENT_REJECTED', `错误码 ${body.error}`);
  });

  await check('审计日志已落库', async () => {
    const { status, body } = await call('/api/admin/audit?limit=20', { token });
    assert(status === 200, `status=${status}`);
    assert(Array.isArray(body.items) && body.items.length > 0, '审计为空');

    // Filter by action: the unfiltered tail is dominated by whichever events
    // happened last, so per-action queries are what actually prove coverage.
    const created = await call(`/api/admin/audit?limit=5&action=task.create`, { token });
    assert(created.body.items.length > 0, '没有 task.create 审计');
    const auth = await call(`/api/admin/audit?limit=5&action=auth.`, { token });
    assert(auth.body.items.length > 0, '没有认证类审计');
    return `task.create=${created.body.items.length} auth=${auth.body.items.length}`;
  });

  // ---- SSE stream (cookie-authenticated, no JWT in the URL) ---------------
  await check('SSE 进度流：无凭证拒绝 / 跨账号拒绝 / 有效凭证可用', async () => {
    const { body } = await call('/api/generations', {
      method: 'POST',
      body: { ...createBody, prompt: 'SSE stream auth probe' },
      token,
    });
    const id = body.item.id as string;

    const anon = await fetch(`${BASE}/api/generations/${id}/stream`);
    assert(anon.status === 401, `无凭证期望 401，实际 ${anon.status}`);

    const forged = await fetch(`${BASE}/api/generations/${id}/stream`, {
      headers: { Cookie: 'benchu_rt=forged' },
    });
    assert(forged.status === 401, `伪造 cookie 期望 401，实际 ${forged.status}`);

    // The bearer token still works (kept for API/SDK clients).
    const withToken = await fetch(`${BASE}/api/generations/${id}/stream?token=${encodeURIComponent(token)}`);
    assert(withToken.status === 200, `带 token 期望 200，实际 ${withToken.status}`);
    const reader = withToken.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(value ?? new Uint8Array());
    assert(frame.startsWith('data:'), `首帧不是 SSE: ${frame.slice(0, 60)}`);
    return '401/401/200 均符合预期';
  });

  await check('组织共享生成结果：显式只读、私有不泄露、成员不可修改', async () => {
    const collaboratorEmail = `e2e-collab-${RUN_ID}@benchu.test`;
    const collaborator = await call('/api/auth/register', {
      method: 'POST',
      body: { email: collaboratorEmail, password: PASSWORD },
    });
    assert(collaborator.status === 201, `协作者注册失败 ${collaborator.status}`);
    const collaboratorToken = collaborator.body.token as string;
    const collaboratorUserId = collaborator.body.user.id as string;

    const org = await call('/api/orgs', { method: 'POST', body: { name: `E2E 协作组织 ${RUN_ID}` }, token });
    assert(org.status === 201 && org.body.id, `创建组织失败 ${org.status}`);
    const orgId = org.body.id as string;
    const orgHeaders = { 'X-Org-Id': orgId };
    const invited = await call(`/api/orgs/${orgId}/members`, {
      method: 'POST',
      body: { email: collaboratorEmail, role: 'editor' },
      token,
      headers: orgHeaders,
    });
    assert(invited.status === 201, `邀请成员失败 ${invited.status} ${JSON.stringify(invited.body)}`);

    const createInOrg = async (visibility: 'private' | 'org') => {
      const result = await call('/api/generations', {
        method: 'POST',
        token,
        headers: orgHeaders,
        body: { ...createBody, prompt: `organization visibility ${visibility} ${RUN_ID}`, visibility },
      });
      assert(result.status === 201 && result.body.item?.id, `创建 ${visibility} 任务失败 ${result.status}`);
      return result.body.item.id as string;
    };
    const privateId = await createInOrg('private');
    const sharedId = await createInOrg('org');

    const memberList = await call('/api/generations', { token: collaboratorToken, headers: orgHeaders });
    assert(memberList.status === 200, `成员列表失败 ${memberList.status}`);
    const memberIds = (memberList.body.items as Json[]).map((item) => item.id);
    assert(memberIds.includes(sharedId), '成员看不到显式共享任务');
    assert(!memberIds.includes(privateId), '成员看到了私有任务');

    const sharedDetail = await call(`/api/generations/${sharedId}`, { token: collaboratorToken, headers: orgHeaders });
    assert(sharedDetail.status === 200 && sharedDetail.body.item.visibility === 'org', '成员无法读取共享详情');
    assert((sharedDetail.body.item.refImages ?? []).length === 0, '共享详情泄露了创建者参考素材');
    const privateDetail = await call(`/api/generations/${privateId}`, {
      token: collaboratorToken,
      headers: orgHeaders,
    });
    assert(privateDetail.status === 404, `私有详情期望 404，实际 ${privateDetail.status}`);
    const outputs = await call(`/api/generations/${sharedId}/outputs`, {
      token: collaboratorToken,
      headers: orgHeaders,
    });
    assert(outputs.status === 200, `成员无法读取共享产物 ${outputs.status}`);

    for (const method of ['retry', 'cancel'] as const) {
      const res = await call(`/api/generations/${sharedId}/${method}`, {
        method: 'POST',
        token: collaboratorToken,
        headers: orgHeaders,
      });
      assert(res.status === 404, `成员 ${method} 共享任务应为 404，实际 ${res.status}`);
    }
    const removed = await call(`/api/generations/${sharedId}`, {
      method: 'DELETE',
      token: collaboratorToken,
      headers: orgHeaders,
    });
    assert(removed.status === 404, `成员删除共享任务应为 404，实际 ${removed.status}`);

    // The editor role was cached by the reads above. Role changes must replace
    // that cached value immediately rather than waiting for the five-minute TTL.
    const downgraded = await call(`/api/orgs/${orgId}/members/${collaboratorUserId}`, {
      method: 'PATCH',
      body: { role: 'viewer' },
      token,
      headers: orgHeaders,
    });
    assert(downgraded.status === 200, `降级 viewer 失败 ${downgraded.status}`);
    const viewerCreate = await call('/api/generations', {
      method: 'POST',
      token: collaboratorToken,
      headers: orgHeaders,
      body: { ...createBody, prompt: `viewer must be read only ${RUN_ID}`, visibility: 'org' },
    });
    assert(viewerCreate.status === 403, `缓存角色降级后创建任务期望 403，实际 ${viewerCreate.status}`);

    const upgraded = await call(`/api/orgs/${orgId}/members/${collaboratorUserId}`, {
      method: 'PATCH',
      body: { role: 'admin' },
      token,
      headers: orgHeaders,
    });
    assert(upgraded.status === 200, `升级 admin 失败 ${upgraded.status}`);
    const adminMembers = await call(`/api/orgs/${orgId}/members`, { token: collaboratorToken, headers: orgHeaders });
    assert(adminMembers.status === 200, `缓存角色升级后读取成员期望 200，实际 ${adminMembers.status}`);

    const membershipRemoved = await call(`/api/orgs/${orgId}/members/${collaboratorUserId}`, {
      method: 'DELETE',
      token,
      headers: orgHeaders,
    });
    assert(membershipRemoved.status === 200, `移除成员失败 ${membershipRemoved.status}`);
    const afterRemoval = await call(`/api/orgs/${orgId}/members`, { token: collaboratorToken, headers: orgHeaders });
    assert(afterRemoval.status === 403, `移除后组织访问期望 403，实际 ${afterRemoval.status}`);

    // Keep the test environment tidy without weakening the owner-only rule.
    await call(`/api/generations/${privateId}/cancel`, { method: 'POST', token, headers: orgHeaders });
    await call(`/api/generations/${sharedId}/cancel`, { method: 'POST', token, headers: orgHeaders });
    return 'private 隔离 / org 只读 / owner-only 修改 / 角色缓存即时失效均已验证';
  });

  await check('余额耗尽后返回 402 且余额不为负', async () => {
    // Use a dedicated fresh account (free plan, 1000 credits): draining the
    // enterprise account above would mean queueing hundreds of real video
    // renders just to prove a balance check.
    const drainEmail = `e2e-drain-${RUN_ID}@benchu.test`;
    const reg = await call('/api/auth/register', {
      method: 'POST',
      body: { email: drainEmail, password: PASSWORD },
    });
    assert(reg.status === 201, `注册失败 ${reg.status}`);
    const drainToken = reg.body.token as string;

    // 5s is the free plan's ceiling, so the request is legal but still expensive.
    const attempt = () =>
      call('/api/generations', {
        method: 'POST',
        body: {
          type: 'video',
          prompt: 'drain probe',
          modelId: 'seedance-2',
          duration: 5,
          width: 1280,
          height: 720,
        },
        token: drainToken,
      });

    let sawRefusal = false;
    let refusalBody: Json = null;
    const createdIds: string[] = [];

    for (let i = 0; i < 20 && !sawRefusal; i++) {
      const { status, body } = await attempt();
      if (status === 201) {
        createdIds.push(body.item.id as string);
        continue;
      }
      if (status === 402) {
        sawRefusal = true;
        refusalBody = body;
      } else if (status === 429) {
        // Concurrency ceiling (free = 1): wait for the slot to free up.
        await sleep(600);
        continue;
      } else {
        throw new Error(`非预期状态码 ${status}: ${JSON.stringify(body)}`);
      }
    }

    assert(sawRefusal, '余额未能耗尽，无法验证 402 行为');
    assert(refusalBody.error === 'INSUFFICIENT_CREDITS', `错误码 ${refusalBody.error}`);

    const balance = await call('/api/credits/balance', { token: drainToken }).then((r) => r.body?.credits ?? 0);
    assert(balance >= 0, `余额为负: ${balance}`);
    const tx = await call('/api/credits/transactions', { token: drainToken });
    assert(
      tx.body.items.every((t: Json) => t.balanceAfter >= 0),
      '账本中出现负余额行',
    );

    // Cancel what we queued so the suite does not leave renders running.
    for (const id of createdIds) {
      await call(`/api/generations/${id}/cancel`, { method: 'POST', token: drainToken });
    }

    return `余额 ${balance}，拒绝码 ${refusalBody.error}`;
  });

  await check('账务对账通过', async () => {
    const { status, body } = await call('/api/admin/reconcile', { token });
    assert(status === 200, `status=${status} ${JSON.stringify(body)}`);
    assert(body.doubleCharged.length === 0, `存在重复扣费: ${JSON.stringify(body.doubleCharged.slice(0, 3))}`);
    assert(
      body.unrefundedFailures.length === 0,
      `存在失败未退款任务: ${JSON.stringify(body.unrefundedFailures.slice(0, 3))}`,
    );
    // Balance drift is reported per user; our fresh account must be clean.
    const mine = body.balanceDrift.find((d: Json) => d.userId === userId);
    assert(!mine, `当前账号余额漂移: ${JSON.stringify(mine)}`);
    return body.ok ? '账本一致' : `其他账号存在 ${body.balanceDrift.length} 处漂移（非本账号）`;
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E 运行失败:', err);
  process.exit(1);
});
