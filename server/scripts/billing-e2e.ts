/**
 * 支付流程验证：套餐目录 / 下单 / 篡改价格 / webhook 幂等 / 并发配额
 *
 *   npm run drill:billing
 */
const BASE = (process.env.API_BASE ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me';

let passed = 0;
let failed = 0;
const ok = (s, d = '') => (passed++, console.log(`  ✔ ${s}${d ? ` — ${d}` : ''}`));
const bad = (s, d = '') => (failed++, console.error(`  ✘ ${s}${d ? ` — ${d}` : ''}`));
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function check(name, fn) {
  try {
    ok(name, (await fn()) ?? '');
  } catch (e) {
    bad(name, e.message);
  }
}

async function call(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const { createHmac } = await import('node:crypto');
const sign = (payload) => createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

const email = `bill-${Date.now()}@benchu.test`;
const reg = await call('/api/auth/register', {
  method: 'POST',
  body: { email, password: 'billing-test-1' },
});
assert(reg.status === 201, `注册失败 ${reg.status} ${JSON.stringify(reg.body)}`);
const token = reg.body.token;
console.log(`▶ 支付流程验证 ${BASE}\n   账号 ${email}（初始 ${reg.body.user.credits} 积分）`);

let packs = [];

await check('套餐与充值包目录可读', async () => {
  const { status, body } = await call('/api/billing/catalogue');
  assert(status === 200, `status=${status}`);
  assert(body.plans.length >= 3, `套餐只有 ${body.plans.length} 个`);
  assert(body.packs.length >= 1, '没有充值包');
  packs = body.packs;
  return `${body.plans.length} 套餐 / ${body.packs.length} 充值包 / 网关=${body.gateway.provider}`;
});

await check('当前订阅与并发配额', async () => {
  const { status, body } = await call('/api/billing/subscription', { token });
  assert(status === 200, `status=${status}`);
  assert(body.plan.id === 'free', `新账号套餐应为 free，实际 ${body.plan.id}`);
  assert(body.plan.maxConcurrent >= 1, '并发上限异常');
  return `${body.plan.name}（并发 ${body.plan.maxConcurrent}，已用 ${body.activeTasks}）`;
});

let orderId = '';

await check('下单：金额与积分由服务端决定', async () => {
  const pack = packs[0];
  const { status, body } = await call('/api/billing/checkout', {
    method: 'POST',
    body: { kind: 'credits', skuId: pack.id },
    token,
  });
  assert(status === 201, `status=${status} ${JSON.stringify(body)}`);
  assert(body.item.amountCents === pack.priceCents, `金额 ${body.item.amountCents} ≠ 目录 ${pack.priceCents}`);
  assert(body.item.credits === pack.credits + pack.bonus, `积分 ${body.item.credits} ≠ 目录 ${pack.credits + pack.bonus}`);
  assert(body.payUrl, '缺少支付链接');
  orderId = body.item.id;
  return `${body.item.skuName} ¥${(body.item.amountCents / 100).toFixed(2)} → ${body.item.credits} 积分`;
});

await check('客户端无法篡改价格（多余字段被忽略）', async () => {
  const pack = packs[0];
  const { status, body } = await call('/api/billing/checkout', {
    method: 'POST',
    body: {
      kind: 'credits',
      skuId: pack.id,
      // 恶意字段：服务端必须完全忽略
      amountCents: 1,
      credits: 999999,
      status: 'paid',
    },
    token,
  });
  assert(status === 201, `status=${status}`);
  assert(body.item.amountCents === pack.priceCents, `金额被篡改为 ${body.item.amountCents}`);
  assert(body.item.credits === pack.credits + pack.bonus, `积分被篡改为 ${body.item.credits}`);
  assert(body.item.status === 'pending', `状态被篡改为 ${body.item.status}`);
  return '价格/积分/状态均未被污染';
});

const balanceBefore = await call('/api/credits/balance', { token }).then((r) => r.body.credits);

await check('未支付时不得充值', async () => {
  const balance = await call('/api/credits/balance', { token }).then((r) => r.body.credits);
  assert(balance === balanceBefore, `余额从 ${balanceBefore} 变为 ${balance}`);
  const orders = await call('/api/billing/orders', { token });
  const o = orders.body.items.find((x) => x.id === orderId);
  assert(o.status === 'pending', `订单状态 ${o.status}`);
  return '订单仍为 pending，余额未变';
});

await check('伪造签名的 webhook 被拒绝', async () => {
  const raw = JSON.stringify({ eventId: `evt-${Date.now()}`, orderId, type: 'paid', txnId: 'txn-forged' });
  const res = await fetch(`${BASE}/api/billing/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-signature': 'deadbeef' },
    body: raw,
  });
  assert(res.status === 401, `期望 401，实际 ${res.status}`);
  const balance = await call('/api/credits/balance', { token }).then((r) => r.body.credits);
  assert(balance === balanceBefore, `伪造 webhook 竟然改了余额: ${balanceBefore}→${balance}`);
  return '401 且余额未变';
});

await check('未签名 webhook 被拒绝', async () => {
  const raw = JSON.stringify({ eventId: `evt-${Date.now()}`, orderId, type: 'paid' });
  const res = await fetch(`${BASE}/api/billing/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
  assert(res.status === 401, `期望 401，实际 ${res.status}`);
  return '401';
});

const packCredits = await call('/api/billing/orders', { token }).then(
  (r) => r.body.items.find((x) => x.id === orderId).credits,
);

await check('合法 webhook 充值成功', async () => {
  const raw = JSON.stringify({
    eventId: `evt-${Date.now()}-a`,
    orderId,
    type: 'paid',
    txnId: `txn-${Date.now()}`,
  });
  const res = await fetch(`${BASE}/api/billing/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-signature': sign(raw) },
    body: raw,
  });
  const body = await res.json();
  assert(res.status === 200, `status=${res.status}`);
  assert(body.outcome === 'processed', `outcome=${body.outcome}`);

  const balance = await call('/api/credits/balance', { token }).then((r) => r.body.credits);
  assert(balance === balanceBefore + packCredits, `余额 ${balanceBefore}→${balance}，期望 +${packCredits}`);
  return `+${packCredits} 积分`;
});

await check('同一事件重复投递不重复充值（幂等）', async () => {
  const eventId = `evt-dup-${Date.now()}`;
  const raw = JSON.stringify({ eventId, orderId, type: 'paid', txnId: 'txn-dup' });
  const headers = { 'Content-Type': 'application/json', 'x-mock-signature': sign(raw) };

  const first = await fetch(`${BASE}/api/billing/webhook/mock`, { method: 'POST', headers, body: raw });
  const second = await fetch(`${BASE}/api/billing/webhook/mock`, { method: 'POST', headers, body: raw });
  const b2 = await second.json();
  assert(first.status === 200 && second.status === 200, `status ${first.status}/${second.status}`);
  assert(b2.outcome === 'duplicate' || b2.outcome === 'ignored', `第二次 outcome=${b2.outcome}`);

  const balance = await call('/api/credits/balance', { token }).then((r) => r.body.credits);
  assert(balance === balanceBefore + packCredits, `重复投递导致余额变成 ${balance}`);
  return `第二次 outcome=${b2.outcome}，余额未变`;
});

await check('不同事件重复支付同一订单不重复充值', async () => {
  const raw = JSON.stringify({ eventId: `evt-other-${Date.now()}`, orderId, type: 'paid', txnId: 'txn-x' });
  const res = await fetch(`${BASE}/api/billing/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-signature': sign(raw) },
    body: raw,
  });
  const body = await res.json();
  assert(body.outcome === 'duplicate', `outcome=${body.outcome}`);
  const balance = await call('/api/credits/balance', { token }).then((r) => r.body.credits);
  assert(balance === balanceBefore + packCredits, `余额被二次充值: ${balance}`);
  return '已被 CAS 拦截';
});

await check('提升并发配额需先购买套餐', async () => {
  const sub = await call('/api/billing/subscription', { token });
  assert(sub.body.plan.maxConcurrent === 1, `free 套餐并发应为 1，实际 ${sub.body.plan.maxConcurrent}`);

  const checkout = await call('/api/billing/checkout', {
    method: 'POST',
    body: { kind: 'plan', skuId: 'pro' },
    token,
  });
  assert(checkout.status === 201, `下单失败 ${checkout.status}`);

  const raw = JSON.stringify({
    eventId: `evt-plan-${Date.now()}`,
    orderId: checkout.body.item.id,
    type: 'paid',
    txnId: `txn-plan-${Date.now()}`,
  });
  const res = await fetch(`${BASE}/api/billing/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mock-signature': sign(raw) },
    body: raw,
  });
  assert(res.status === 200, `webhook ${res.status}`);

  const after = await call('/api/billing/subscription', { token });
  assert(after.body.plan.id === 'pro', `套餐未升级: ${after.body.plan.id}`);
  assert(after.body.plan.maxConcurrent === 4, `并发未提升: ${after.body.plan.maxConcurrent}`);
  return `free(1) → pro(${after.body.plan.maxConcurrent})`;
});

await check('免费套餐无法请求超长视频', async () => {
  // pro 套餐 10 秒，请求 12 秒应被套餐上限拦截（模型本身支持 12 秒）
  const { status, body } = await call('/api/generations', {
    method: 'POST',
    body: { type: 'video', prompt: '超长视频', modelId: 'seedance-2', duration: 12, width: 1280, height: 720 },
    token,
  });
  assert(status === 400, `期望 400，实际 ${status}`);
  assert(/套餐/.test(body.message ?? ''), `错误信息未提及套餐: ${body.message}`);
  return body.message.slice(0, 40);
});

await check('并发配额生效（并行超限）', async () => {
  const pro = await call('/api/billing/subscription', { token }).then((r) => r.body.plan);
  const active = await call('/api/billing/subscription', { token }).then((r) => r.body.activeTasks);
  const slots = Math.max(0, pro.maxConcurrent - active);
  assert(slots > 0, `当前无可用并发额度（${active}/${pro.maxConcurrent}）`);

  // Video tasks, not images: a 512px image finishes in ~200ms, so it releases
  // its slot mid-test and a sequential/parallel burst would never trip the
  // ceiling. A 6s video keeps the slot occupied long enough to exercise the
  // real race (count-then-insert TOCTOU).
  const body = (i) => ({
    type: 'video',
    prompt: `并发压测 ${i}`,
    modelId: 'seedance-2',
    duration: 6,
    width: 1280,
    height: 720,
  });
  const total = slots + 3;
  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      call('/api/generations', { method: 'POST', body: body(i), token }),
    ),
  );

  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 429);
  const other = results.filter((r) => r.status !== 201 && r.status !== 429);
  assert(other.length === 0, `出现非预期状态码: ${other.map((r) => r.status).join(',')}`);
  assert(
    created.length <= slots,
    `并发上限 ${slots}，却创建了 ${created.length} 个任务（配额失效）`,
  );
  assert(rejected.length > 0, `超发 ${total - slots} 个请求，但没有任何 429`);
  assert(
    rejected.every((r) => r.body.error === 'CONCURRENCY_LIMIT'),
    `429 错误码不一致: ${[...new Set(rejected.map((r) => r.body.error))].join(',')}`,
  );

  for (const r of created) await call(`/api/generations/${r.body.item.id}/cancel`, { method: 'POST', token });
  return `并发 ${total} 个请求 → 建 ${created.length} / 拒 ${rejected.length}（上限 ${slots}）`;
});

await check('订单金额与入账积分一致（营收对账）', async () => {
  const orders = await call('/api/billing/orders', { token });
  const paid = orders.body.items.filter((o) => o.status === 'paid');
  assert(paid.length >= 2, `已支付订单只有 ${paid.length} 个`);

  const tx = await call('/api/credits/transactions', { token });
  for (const o of paid) {
    const rows = tx.body.items.filter((t) => t.refId === o.id && t.delta > 0);
    const sum = rows.reduce((s, t) => s + t.delta, 0);
    assert(rows.length === 1, `订单 ${o.skuName} 入账行数 ${rows.length}`);
    assert(sum === o.credits, `订单 ${o.skuName} 应收 ${o.credits}，实收 ${sum}`);
  }
  return `${paid.length} 笔订单入账一致`;
});

await check('系统账务对账仍然通过', async () => {
  const { status, body } = await call('/api/admin/reconcile', { token });
  assert(status === 200, `status=${status}`);
  assert(body.balanceDrift.length === 0, `余额漂移: ${JSON.stringify(body.balanceDrift.slice(0, 2))}`);
  assert(body.doubleCharged.length === 0, '存在重复扣费');
  return '余额=流水，无重复扣费';
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
