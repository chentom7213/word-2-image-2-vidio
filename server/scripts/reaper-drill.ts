/**
 * Chaos drill: a worker dies mid-render after the user has been charged.
 *
 * This is the single most important recovery path on the platform — money is
 * gone, no artifact can ever appear, and nobody notices by hand. The reaper
 * must fail the task AND refund it, exactly once.
 *
 * Determinism matters more than realism here: creating a task through the API
 * and then faking its heartbeat races against the live worker, which finishes
 * the render first and voids the setup. Instead we insert the *end state* a
 * crashed worker would leave behind — a `running` row with an ancient
 * heartbeat plus the matching debit — and let the real reaper/refund code run
 * against it.
 *
 *   npm run drill:reaper
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { exec, queryOne, withTransaction } from '../src/db/pool.js';
import { adjustCredits } from '../src/services/credits.js';
import { reapStaleTasks, staleRunningCount } from '../src/services/pipeline.js';

let passed = 0;
let failed = 0;
const ok = (s: string, d = '') => (passed++, console.log(`  ✔ ${s}${d ? ` — ${d}` : ''}`));
const bad = (s: string, d = '') => (failed++, console.error(`  ✘ ${s}${d ? ` — ${d}` : ''}`));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    ok(name, (await fn()) ?? '');
  } catch (err) {
    bad(name, err instanceof Error ? err.message : String(err));
  }
}

const BASE = (process.env.API_BASE ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const COST = 30;

async function main() {
  console.log(`▶ 僵尸任务回收演练 ${BASE}`);

  const email = `drill-${Date.now()}@benchu.test`;
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'drill-password-1' },
  });
  assert(reg.status === 201, `注册失败 ${reg.status} ${JSON.stringify(reg.body)}`);
  const token = reg.body.token as string;
  const userId = reg.body.user.id as string;

  const balanceBefore = await call('/api/credits/balance', { token }).then(
    (r) => r.body.credits as number,
  );

  // Reproduce the exact post-crash state: charged, `running`, no heartbeat,
  // never enqueued. No worker can reach it because there is no queue entry.
  const taskId = randomUUID();
  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO generation_tasks
        (id, org_id, user_id, type, prompt, model_id, model_name, resolution,
         width, height, duration, \`count\`, status, progress, seed, credits_cost,
         started_at, heartbeat_at, priority, attempts, max_attempts)
       VALUES (?, NULL, ?, 'image', 'reaper drill · worker 已死', 'nano-banana', 'Nano Banana',
               '512', 512, 512, 0, 1, 'running', 37, ?, ?,
               NOW() - INTERVAL 2 HOUR, NOW() - INTERVAL 2 HOUR, 5, 1, 3)`,
      [taskId, userId, `drill-${taskId}`, COST],
    );
    await adjustCredits(conn, userId, -COST, '生成任务扣费 · Nano Banana', taskId);
  });

  await check('僵尸任务被识别', async () => {
    const n = await staleRunningCount();
    assert(n >= 1, `staleRunningCount=${n}`);
    return `${n} 个`;
  });

  await check('reaper 失败并退款（只退一次）', async () => {
    const reaped = await reapStaleTasks();
    assert(reaped.failed >= 1, `reaped=${reaped.failed}`);

    const row = await queryOne<any>(
      'SELECT status, error_code, refunded_at FROM generation_tasks WHERE id = ?',
      [taskId],
    );
    assert(row.status === 'failed', `status=${row.status}`);
    assert(row.error_code === 'PROVIDER_TIMEOUT', `error_code=${row.error_code}`);
    assert(row.refunded_at, '未退款');

    const after = await call('/api/credits/balance', { token }).then((r) => r.body.credits as number);
    assert(after === balanceBefore, `余额 ${balanceBefore}→${after}，期望回到 ${balanceBefore}`);
    return `${balanceBefore - COST} → ${after}`;
  });

  await check('重复执行 reaper 不会二次退款', async () => {
    await reapStaleTasks();
    await reapStaleTasks();
    const after = await call('/api/credits/balance', { token }).then((r) => r.body.credits as number);
    assert(after === balanceBefore, `二次退款导致余额 ${after} ≠ ${balanceBefore}`);

    const refunds = await call('/api/credits/transactions', { token });
    const rows = refunds.body.items.filter((t: any) => t.refId === taskId && t.delta > 0);
    assert(rows.length === 1, `退款流水 ${rows.length} 条（应恰好 1 条）`);
    return '幂等';
  });

  await check('用户可重试已退款任务', async () => {
    await sleep(500);
    const retry = await call(`/api/generations/${taskId}/retry`, { method: 'POST', token });
    assert(retry.status === 200, `retry ${retry.status} ${JSON.stringify(retry.body)}`);
    assert(retry.body.item.status === 'queued', `status=${retry.body.item.status}`);
    const after = await call('/api/credits/balance', { token }).then((r) => r.body.credits as number);
    assert(after === balanceBefore - COST, `重试后余额 ${after}，期望 ${balanceBefore - COST}`);
    return '已重新入队并重新扣费';
  });

  await check('任务最终完成，产物可下载', async () => {
    for (let i = 0; i < 90; i++) {
      const { body } = await call(`/api/generations/${taskId}`, { token });
      if (body.item.status === 'done') {
        const outputs = body.item.outputs ?? [];
        assert(outputs.length > 0, '没有产物');
        return `${outputs.length} 个产物`;
      }
      if (body.item.status === 'failed') throw new Error(`失败 ${body.item.errorCode}`);
      await sleep(700);
    }
    throw new Error('等待超时');
  });

  await check('账务仍然一致', async () => {
    const recon = await call('/api/admin/reconcile', { token });
    assert(recon.status === 200, `reconcile ${recon.status}`);
    assert(recon.body.doubleCharged.length === 0, '存在重复扣费');
    assert(recon.body.unrefundedFailures.length === 0, '存在失败未退款任务');
    const mine = recon.body.balanceDrift.find((d: any) => d.userId === userId);
    assert(!mine, `余额漂移: ${JSON.stringify(mine)}`);
    return '余额=流水';
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('演练失败:', err);
  process.exit(1);
});
