import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';
import { cursorStamp } from '../src/services/generation-page.js';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];

vi.mock('../src/db/pool.js', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return rows;
  },
  queryOne: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return rows[0] ?? null;
  },
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (req: { userId?: string }) => {
    req.userId = 'user-1';
  },
}));

import { creditRoutes } from '../src/routes/credits.js';

function tx(id: string, createdAt: string | Date, delta = 1) {
  return {
    id,
    delta,
    balance_after: 10,
    reason: '测试',
    ref_id: null,
    created_at: createdAt,
  };
}

async function withApp(run: (server: FastifyInstance) => Promise<void>) {
  const server = Fastify();
  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = Number((err as { statusCode?: number }).statusCode) || 500;
    return reply.code(status).send({ message: err instanceof Error ? err.message : 'error' });
  });
  await server.register(creditRoutes);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe('credit transaction pages', () => {
  beforeEach(() => {
    queries.length = 0;
    rows = [];
  });

  it('keeps a 100 row cap and a null cursor when the client does not page', async () => {
    rows = [tx('tx-1', '2026-10-26 11:14:02')];
    await withApp(async (server) => {
      const response = await server.inject({ method: 'GET', url: '/api/credits/transactions' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: 'tx-1',
            delta: 1,
            balanceAfter: 10,
            reason: '测试',
            refId: null,
            createdAt: Date.parse('2026-10-26T11:14:02Z'),
          },
        ],
        nextCursor: null,
      });
      expect(queries[0]?.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(queries[0]?.sql).not.toContain('created_at <');
      expect(queries[0]?.params).toEqual(['user-1', 100]);
    });
  });

  it('adds a database timestamp cursor only when the default page is full', async () => {
    rows = Array.from({ length: 100 }, (_, index) => tx(`tx-${index}`, '2026-10-26 11:14:02.123'));
    await withApp(async (server) => {
      const response = await server.inject({ method: 'GET', url: '/api/credits/transactions' });
      const body = response.json();
      expect(body.items).toHaveLength(100);
      expect(typeof body.items[99].createdAt).toBe('number');
      expect(body.nextCursor).toEqual({ createdAt: '2026-10-26 11:14:02.123', id: 'tx-99' });
      expect(queries[0]?.params).toEqual(['user-1', 100]);
    });
  });

  it('stamps the cursor from created_at instead of the millisecond field', async () => {
    const createdAt = new Date('2026-10-26T11:14:02.123Z');
    rows = [tx('tx-date', createdAt)];
    await withApp(async (server) => {
      const response = await server.inject({ method: 'GET', url: '/api/credits/transactions?limit=1' });
      const body = response.json();
      expect(body.items[0].createdAt).toBe(createdAt.getTime());
      expect(body.nextCursor).toEqual({ createdAt: cursorStamp(createdAt), id: 'tx-date' });
      expect(body.nextCursor.createdAt).toBe('2026-10-26 11:14:02.123');
    });
  });

  it('requests an older page with the generation cursor', async () => {
    rows = [tx('tx-old', '2026-10-26 10:00:00')];
    await withApp(async (server) => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/credits/transactions?limit=50&before=2026-10-26%2011:14:02.123&beforeId=tx-9',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().nextCursor).toBeNull();
      expect(queries[0]?.sql).toContain('AND (created_at < ? OR (created_at = ? AND id < ?))');
      expect(queries[0]?.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(queries[0]?.params).toEqual(['user-1', '2026-10-26 11:14:02.123', '2026-10-26 11:14:02.123', 'tx-9', 50]);
    });
  });

  it('rejects an invalid cursor before querying', async () => {
    rows = [tx('tx-1', '2026-10-26 11:14:02')];
    await withApp(async (server) => {
      const missingId = await server.inject({
        method: 'GET',
        url: '/api/credits/transactions?before=2026-10-26%2011:14:02',
      });
      const invalid = await server.inject({
        method: 'GET',
        url: '/api/credits/transactions?before=not-a-time&beforeId=tx-1',
      });
      expect(missingId.statusCode).toBe(400);
      expect(missingId.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(queries).toHaveLength(0);
    });
  });

  it('follows the parsed page size when a limit is present', async () => {
    await withApp(async (server) => {
      await server.inject({ method: 'GET', url: '/api/credits/transactions?limit=50' });
      await server.inject({ method: 'GET', url: '/api/credits/transactions?limit=500' });
      expect(queries.map((item) => item.params[1])).toEqual([50, 200]);
    });
  });
});
