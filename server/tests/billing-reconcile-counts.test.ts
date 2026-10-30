import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

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
  requireAuth: async (req: { userId?: string }) => {
    req.userId = 'user-1';
  },
  requireOrg: async (req: { orgId?: string }) => {
    req.orgId = 'org-1';
  },
  requireRole: () => async () => {},
}));

import { ApiError } from '../src/lib/errors.js';
import { billingRoutes } from '../src/routes/billing.js';

const REAL_COUNTS = { creditMismatch: 150, paidWithoutWebhook: 120 };

function compact(sql: unknown) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function isCountQuery(sql: string) {
  return sql.startsWith('SELECT COUNT(*) AS c');
}

function mismatchRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `mismatch-${index}`,
    sku_id: 'pack-1',
    credits: 100,
    paid_at: '2026-10-26 11:14:02',
    credited: 0,
  }));
}

function webhookRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `webhook-${index}`,
    sku_id: 'pack-1',
  }));
}

async function billingApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    return reply.code(500).send({ error: 'INTERNAL', message: '服务器内部错误' });
  });
  await app.register(billingRoutes);
  return app;
}

describe('admin billing reconcile counts', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue([]);
  });

  it('keeps a 100-row sample while counts and ok use the full totals', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      const text = compact(sql);
      const count = isCountQuery(text);
      if (text.includes("reason LIKE '充值到账%'")) return count ? [{ c: REAL_COUNTS.creditMismatch }] : mismatchRows(100);
      if (text.includes("e.outcome = 'processed'")) return count ? [{ c: REAL_COUNTS.paidWithoutWebhook }] : webhookRows(100);
      return [];
    });
    const app = await billingApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/billing/reconcile' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.creditMismatch).toHaveLength(100);
      expect(body.paidWithoutWebhook).toHaveLength(100);
      expect(body.creditMismatch[0]).toEqual({ orderId: 'mismatch-0', skuId: 'pack-1', ordered: 100, credited: 0 });
      expect(body.creditMismatch[99]).toEqual({ orderId: 'mismatch-99', skuId: 'pack-1', ordered: 100, credited: 0 });
      expect(body.paidWithoutWebhook[0]).toEqual({ orderId: 'webhook-0', skuId: 'pack-1' });
      expect(body.paidWithoutWebhook[99]).toEqual({ orderId: 'webhook-99', skuId: 'pack-1' });
      expect(body.counts).toEqual(REAL_COUNTS);
      expect(body.counts.creditMismatch).toBeGreaterThan(body.creditMismatch.length);
      expect(body.counts.paidWithoutWebhook).toBeGreaterThan(body.paidWithoutWebhook.length);
      expect(body.ok).toBe(false);

      const calls = mocks.query.mock.calls.map((call) => ({ sql: compact(call[0]), params: call[1] as unknown[] }));
      expect(calls).toHaveLength(4);
      const mismatch = calls.filter((call) => call.sql.includes("reason LIKE '充值到账%'"));
      const webhook = calls.filter((call) => call.sql.includes("e.outcome = 'processed'"));
      expect(mismatch).toHaveLength(2);
      expect(webhook).toHaveLength(2);

      for (const call of [...mismatch, ...webhook]) {
        expect(call.sql).toContain('o.org_id = ?');
        expect(call.sql).toContain("o.status = 'paid'");
        expect(call.params).toEqual(['org-1']);
        if (isCountQuery(call.sql)) expect(call.sql).not.toContain('LIMIT');
        else expect(call.sql).toContain('LIMIT 100');
      }
      for (const call of mismatch) {
        expect(call.sql).toContain('HAVING o.credits <> credited');
        expect(call.sql).toContain("t.reason LIKE '充值到账%'");
        expect(call.sql).toContain('SUM(t.delta)');
      }
      for (const call of webhook) {
        expect(call.sql).toContain('payment_events');
        expect(call.sql).toContain("e.outcome = 'processed'");
      }
    } finally {
      await app.close();
    }
  });
});
