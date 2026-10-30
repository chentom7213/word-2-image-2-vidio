import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { OrderRow } from '../src/services/payments.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  query: mocks.query,
  queryOne: vi.fn(),
  exec: mocks.exec,
  withTransaction: vi.fn(),
  pool: {},
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (req: { userId?: string; role?: string }) => {
    req.userId = 'user-1';
    req.role = 'owner';
  },
  requireOrg: async () => {},
  requireRole: () => async () => {},
}));

import { toMillis } from '../src/lib/dto.js';
import { ApiError } from '../src/lib/errors.js';
import { billingRoutes } from '../src/routes/billing.js';

const EXPIRE_SQL =
  "UPDATE orders SET status = 'expired' WHERE user_id = ? AND status = 'pending' AND expires_at < UTC_TIMESTAMP()";

function order(id: string, createdAt: string): OrderRow {
  return {
    id,
    org_id: 'org-1',
    user_id: 'user-1',
    kind: 'credits',
    sku_id: 'pack-1',
    sku_name: '100 积分',
    amount_cents: 1000,
    credits: 100,
    status: 'pending',
    provider: 'mock',
    provider_order_id: null,
    pay_url: null,
    provider_txn_id: null,
    idempotency_key: null,
    paid_at: null,
    expires_at: '2026-10-27 11:14:02',
    created_at: createdAt,
  };
}

function orders(count: number, createdAt = '2026-10-26 11:14:02.123') {
  return Array.from({ length: count }, (_, index) => order(`order-${index}`, createdAt));
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

describe('billing order pages', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.exec.mockReset();
    mocks.query.mockResolvedValue([]);
    mocks.exec.mockResolvedValue({ affectedRows: 0 });
  });

  it('keeps a 100 row cap and a null cursor when the client does not page', async () => {
    mocks.query.mockResolvedValue(orders(2));
    const app = await ordersApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/billing/orders' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe('order-0');
      expect(body.items[0].createdAt).toBe(toMillis('2026-10-26 11:14:02.123'));
      expect(body.nextCursor).toBeNull();
      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      );
      expect(params).toEqual(['user-1', 100]);
      expect(mocks.exec).toHaveBeenCalledWith(EXPIRE_SQL, ['user-1']);
      expect(mocks.exec.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    } finally {
      await app.close();
    }
  });

  it('returns a MySQL timestamp cursor only when the page is full', async () => {
    const app = await ordersApp();
    try {
      mocks.query.mockResolvedValue(orders(50));
      const full = await app.inject({ method: 'GET', url: '/api/billing/orders?limit=50' });
      expect(full.statusCode).toBe(200);
      expect(full.json().nextCursor).toEqual({ createdAt: '2026-10-26 11:14:02.123', id: 'order-49' });
      expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual(['user-1', 50]);

      mocks.query.mockResolvedValue(orders(49));
      const short = await app.inject({ method: 'GET', url: '/api/billing/orders?limit=50' });
      expect(short.json().nextCursor).toBeNull();

      mocks.query.mockResolvedValue([{ ...order('order-date', '2026-10-26 11:14:02.123'), created_at: new Date('2026-10-26T11:14:02.123Z') }]);
      const stamped = await app.inject({ method: 'GET', url: '/api/billing/orders?limit=1' });
      expect(stamped.json().nextCursor).toEqual({ createdAt: '2026-10-26 11:14:02.123', id: 'order-date' });

      mocks.query.mockResolvedValue([order('order-bad', 'yesterday')]);
      const unusable = await app.inject({ method: 'GET', url: '/api/billing/orders?limit=1' });
      expect(unusable.json().items).toHaveLength(1);
      expect(unusable.json().nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('pages with the shared older-than cursor', async () => {
    mocks.query.mockResolvedValue(orders(1, '2026-10-26 11:00:00'));
    const app = await ordersApp();
    try {
      const before = encodeURIComponent('2026-10-26 11:14:02.123');
      const res = await app.inject({
        method: 'GET',
        url: `/api/billing/orders?limit=50&before=${before}&beforeId=order-49`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().nextCursor).toBeNull();
      const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
      expect(sql.replace(/\s+/g, ' ')).toBe(
        'SELECT * FROM orders WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?',
      );
      expect(params).toEqual(['user-1', '2026-10-26 11:14:02.123', '2026-10-26 11:14:02.123', 'order-49', 50]);
      expect(mocks.exec).toHaveBeenCalledWith(EXPIRE_SQL, ['user-1']);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid cursor with the shared error and does not touch orders', async () => {
    const app = await ordersApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/billing/orders?before=not-a-time&beforeId=order-1',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
