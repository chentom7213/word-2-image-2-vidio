import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { OrderRow } from '../src/services/payments.js';

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

import { toMillis } from '../src/lib/dto.js';
import { ApiError } from '../src/lib/errors.js';
import { billingRoutes } from '../src/routes/billing.js';

const TOTALS_SQL =
  "SELECT SUM(status = 'paid') AS paid_count, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS revenue_cents, COALESCE(SUM(CASE WHEN status = 'paid' THEN credits ELSE 0 END), 0) AS credits_sold FROM orders WHERE org_id = ?";

function order(id: string, createdAt: string | Date): OrderRow {
  return {
    id,
    org_id: 'org-1',
    user_id: 'user-1',
    kind: 'credits',
    sku_id: 'pack-1',
    sku_name: '100 积分',
    amount_cents: 1000,
    credits: 100,
    status: 'paid',
    provider: 'mock',
    provider_order_id: null,
    pay_url: null,
    provider_txn_id: null,
    idempotency_key: null,
    paid_at: null,
    expires_at: '2026-10-27 11:14:02',
    created_at: createdAt as string,
  };
}

function orders(count: number, createdAt: string | Date = '2026-10-26 11:14:02.123') {
  return Array.from({ length: count }, (_, index) => order(`order-${index}`, createdAt));
}

function totalsRow() {
  return [{ paid_count: 4, revenue_cents: 4000, credits_sold: 400 }];
}

async function ordersApp() {
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

describe('admin order pages', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue([]);
  });

  it('keeps limit 50 when the client does not pass a cursor', async () => {
    mocks.query.mockResolvedValueOnce(orders(2)).mockResolvedValueOnce(totalsRow());
    const app = await ordersApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/orders' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe('order-0');
      expect(body.items[0].createdAt).toBe(toMillis('2026-10-26 11:14:02.123'));
      expect(body.items[0].userId).toBe('user-1');
      expect(body.items[0].orgId).toBe('org-1');
      expect(body.nextCursor).toBeNull();
      expect(body.totals).toEqual({ paidCount: 4, revenueCents: 4000, creditsSold: 400 });
      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'SELECT * FROM orders WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      );
      expect(params).toEqual(['org-1', 50]);
      const [totalsSql, totalsParams] = mocks.query.mock.calls[1] as [string, unknown[]];
      expect(totalsSql.replace(/\s+/g, ' ')).toBe(TOTALS_SQL);
      expect(totalsParams).toEqual(['org-1']);
    } finally {
      await app.close();
    }
  });

  it('returns a MySQL timestamp cursor only when the page is full', async () => {
    const app = await ordersApp();
    try {
      mocks.query.mockResolvedValueOnce(orders(50)).mockResolvedValueOnce(totalsRow());
      const full = await app.inject({ method: 'GET', url: '/api/admin/orders?limit=50' });
      expect(full.statusCode).toBe(200);
      expect(full.json().nextCursor).toEqual({ createdAt: '2026-10-26 11:14:02.123', id: 'order-49' });
      expect(full.json().totals).toEqual({ paidCount: 4, revenueCents: 4000, creditsSold: 400 });
      expect(mocks.query.mock.calls[0]?.[1]).toEqual(['org-1', 50]);

      mocks.query.mockResolvedValueOnce(orders(49)).mockResolvedValueOnce(totalsRow());
      const short = await app.inject({ method: 'GET', url: '/api/admin/orders?limit=50' });
      expect(short.json().nextCursor).toBeNull();

      mocks.query
        .mockResolvedValueOnce([order('order-date', new Date('2026-10-26T11:14:02.123Z'))])
        .mockResolvedValueOnce(totalsRow());
      const stamped = await app.inject({ method: 'GET', url: '/api/admin/orders?limit=1' });
      expect(stamped.json().nextCursor).toEqual({ createdAt: '2026-10-26 11:14:02.123', id: 'order-date' });

      mocks.query.mockResolvedValueOnce([order('order-bad', 'yesterday')]).mockResolvedValueOnce(totalsRow());
      const unusable = await app.inject({ method: 'GET', url: '/api/admin/orders?limit=1' });
      expect(unusable.json().items).toHaveLength(1);
      expect(unusable.json().nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('pages with the shared older-than cursor and keeps the status filter', async () => {
    mocks.query.mockResolvedValueOnce(orders(1, '2026-10-26 11:00:00')).mockResolvedValueOnce(totalsRow());
    const app = await ordersApp();
    try {
      const before = encodeURIComponent('2026-10-26 11:14:02.123');
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/orders?status=paid&limit=50&before=${before}&beforeId=order-49`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().nextCursor).toBeNull();
      expect(res.json().totals).toEqual({ paidCount: 4, revenueCents: 4000, creditsSold: 400 });
      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'SELECT * FROM orders WHERE org_id = ? AND status = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?',
      );
      expect(params).toEqual(['org-1', 'paid', '2026-10-26 11:14:02.123', '2026-10-26 11:14:02.123', 'order-49', 50]);
      const [totalsSql, totalsParams] = mocks.query.mock.calls[1] as [string, unknown[]];
      expect(totalsSql.replace(/\s+/g, ' ')).toBe(TOTALS_SQL);
      expect(totalsParams).toEqual(['org-1']);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid cursor and does not query orders', async () => {
    const app = await ordersApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/orders?before=not-a-time&beforeId=order-1',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(mocks.query).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
