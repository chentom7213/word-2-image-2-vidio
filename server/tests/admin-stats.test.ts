import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { orgMemberPredicate, orgTaskParams, orgTaskPredicate } from '../src/services/admin-scope.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: mocks.query,
  queryOne: vi.fn(),
  exec: vi.fn(),
  withTransaction: vi.fn(),
  pool: {},
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (req: { userId?: string; orgId?: string; role?: string }) => {
    req.userId = 'user-1';
    req.orgId = 'org-1';
    req.role = 'owner';
  },
  requireOrg: async () => {},
  requireRole: () => async () => {},
}));

import { ApiError } from '../src/lib/errors.js';
import { adminRoutes } from '../src/routes/admin.js';

const REAL_COUNTS = { balanceDrift: 101, doubleCharged: 180, unrefundedFailures: 240 };

function compact(sql: unknown) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function isCountQuery(sql: string) {
  return sql.startsWith('SELECT COUNT(*) AS c');
}

async function adminApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    return reply.code(500).send({ error: 'INTERNAL', message: '服务器内部错误' });
  });
  await app.register(adminRoutes);
  return app;
}

function taskStats(row: Record<string, number>) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (compact(sql).includes("SUM(status = 'done')")) return [row];
    return [];
  });
}

describe('admin stats and reconcile', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue([]);
  });

  it('counts success only among finished tasks when work is still queued', async () => {
    taskStats({
      total: 15,
      queued: 5,
      running: 0,
      done: 10,
      failed: 0,
      credits_charged: 0,
      credits_refunded: 0,
    });
    const app = await adminApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tasks).toEqual({
        total: 15,
        queued: 5,
        running: 0,
        done: 10,
        failed: 0,
        successRate: 1,
        creditsCharged: 0,
        creditsRefunded: 0,
      });
      const statsCall = mocks.query.mock.calls.find((call) => compact(call[0]).includes("SUM(status = 'done')"));
      expect(compact(statsCall?.[0])).toContain(orgTaskPredicate());
      expect(statsCall?.[1]).toEqual(orgTaskParams('org-1'));
    } finally {
      await app.close();
    }
  });

  it('returns a null success rate when every task is still queued', async () => {
    taskStats({
      total: 5,
      queued: 5,
      running: 0,
      done: 0,
      failed: 0,
      credits_charged: 0,
      credits_refunded: 0,
    });
    const app = await adminApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tasks).toMatchObject({
        total: 5,
        queued: 5,
        running: 0,
        done: 0,
        failed: 0,
        successRate: null,
      });
    } finally {
      await app.close();
    }
  });

  it('keeps reconcile failing when samples stay under 100 but counts are higher', async () => {
    // Empty samples would make a length-based ok succeed. Counts are the real totals.
    mocks.query.mockImplementation(async (sql: string) => {
      const text = compact(sql);
      const count = isCountQuery(text);
      if (text.includes('FROM users u')) return count ? [{ c: REAL_COUNTS.balanceDrift }] : [];
      if (text.includes('credit_transactions')) return count ? [{ c: REAL_COUNTS.doubleCharged }] : [];
      if (text.includes('generation_tasks')) return count ? [{ c: REAL_COUNTS.unrefundedFailures }] : [];
      return [];
    });
    const app = await adminApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/reconcile' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.balanceDrift).toHaveLength(0);
      expect(body.doubleCharged).toHaveLength(0);
      expect(body.unrefundedFailures).toHaveLength(0);
      expect(body.balanceDrift.length).toBeLessThan(100);
      expect(body.doubleCharged.length).toBeLessThan(100);
      expect(body.unrefundedFailures.length).toBeLessThan(100);
      expect(body.counts).toEqual(REAL_COUNTS);
      expect(body.ok).toBe(false);

      const calls = mocks.query.mock.calls.map((call) => ({ sql: compact(call[0]), params: call[1] as unknown[] }));
      expect(calls).toHaveLength(6);
      const drift = calls.filter((call) => call.sql.includes('FROM users u'));
      const charged = calls.filter(
        (call) => call.sql.includes("reason LIKE '生成任务扣费%'") && !call.sql.includes('FROM users u'),
      );
      const unrefunded = calls.filter(
        (call) => call.sql.includes('refunded_at IS NULL') && !call.sql.includes('credit_transactions'),
      );
      expect(drift).toHaveLength(2);
      expect(charged).toHaveLength(2);
      expect(unrefunded).toHaveLength(2);

      for (const call of [...drift, ...charged, ...unrefunded]) {
        if (isCountQuery(call.sql)) expect(call.sql).not.toContain('LIMIT');
        else expect(call.sql).toContain('LIMIT 100');
      }
      for (const call of drift) {
        expect(call.sql).toContain(orgMemberPredicate('u.id'));
        expect(call.sql).toContain('HAVING u.credits <> COALESCE(SUM(t.delta), 0)');
        expect(call.params).toEqual(['org-1']);
      }
      for (const call of [...charged, ...unrefunded]) {
        expect(call.sql).toContain(orgTaskPredicate());
        expect(call.params).toEqual(orgTaskParams('org-1'));
      }
      for (const call of charged) {
        expect(call.sql).toContain("reason LIKE '生成任务扣费%'");
        expect(call.sql).toContain('HAVING COUNT(*) > 1');
      }
      for (const call of unrefunded) {
        expect(call.sql).toContain('refunded_at IS NULL');
        expect(call.sql).toContain("error_code <> 'CANCELLED'");
      }
    } finally {
      await app.close();
    }
  });
});
