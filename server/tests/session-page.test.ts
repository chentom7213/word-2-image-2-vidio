import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/errors.js';

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
  exec: async () => ({ affectedRows: 1 }),
  withTransaction: async (fn: (conn: unknown) => Promise<unknown>) => fn({}),
  pool: {},
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (req: { userId?: string }) => {
    req.userId = 'user-1';
  },
  accountIsSuspended: () => false,
  rejectSuspendedAccount: async () => {},
}));

import { authRoutes } from '../src/routes/auth.js';

function session(id: string, createdAt: string) {
  return {
    id,
    token_hash: `hash-${id}`,
    ip: '203.0.113.9',
    user_agent: 'Browser',
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
  await server.register(authRoutes);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe('session pages', () => {
  beforeEach(() => {
    queries.length = 0;
    rows = [];
  });

  it('keeps a 50 row cap and a null cursor when the client does not page', async () => {
    rows = [session('session-1', '2026-10-26 10:00:00')];
    await withApp(async (server) => {
      const response = await server.inject({ method: 'GET', url: '/api/auth/sessions' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.count).toBe(1);
      expect(body.items).toEqual([
        {
          id: 'session-1',
          createdAt: '2026-10-26 10:00:00',
          ip: '203.0.113.9',
          userAgent: 'Browser',
          current: false,
        },
      ]);
      expect(body.nextCursor).toBeNull();
      expect(JSON.stringify(body)).not.toContain('hash-session-1');
      expect(queries).toHaveLength(1);
      expect(queries[0]?.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(queries[0]?.sql).not.toContain('created_at <');
      expect(queries[0]?.params).toEqual(['user-1', 50]);
    });
  });

  it('returns a cursor when a 20 row page is full', async () => {
    rows = Array.from({ length: 20 }, (_, index) => session(`session-${index}`, '2026-10-26 10:00:00'));
    await withApp(async (server) => {
      const response = await server.inject({ method: 'GET', url: '/api/auth/sessions?limit=20' });
      const body = response.json();
      expect(body.count).toBe(20);
      expect(body.items).toHaveLength(20);
      expect(body.nextCursor).toEqual({ createdAt: '2026-10-26 10:00:00', id: 'session-19' });
      expect(queries[0]?.params).toEqual(['user-1', 20]);
    });
  });

  it('requests an older page with the generation cursor', async () => {
    rows = [session('session-old', '2026-10-26 09:00:00')];
    await withApp(async (server) => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/sessions?limit=20&before=2026-10-26%2011:14:02.123&beforeId=session-9',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().nextCursor).toBeNull();
      expect(queries[0]?.sql).toContain('AND (created_at < ? OR (created_at = ? AND id < ?))');
      expect(queries[0]?.sql).toContain('ORDER BY created_at DESC, id DESC');
      expect(queries[0]?.params).toEqual([
        'user-1',
        '2026-10-26 11:14:02.123',
        '2026-10-26 11:14:02.123',
        'session-9',
        20,
      ]);
    });
  });

  it('rejects an invalid cursor before querying', async () => {
    rows = [session('session-1', '2026-10-26 10:00:00')];
    await withApp(async (server) => {
      const missingId = await server.inject({
        method: 'GET',
        url: '/api/auth/sessions?before=2026-10-26%2010:00:00',
      });
      const invalid = await server.inject({
        method: 'GET',
        url: '/api/auth/sessions?before=not-a-time&beforeId=session-1',
      });
      expect(missingId.statusCode).toBe(400);
      expect(missingId.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'BAD_REQUEST', message: '历史游标无效' });
      expect(queries).toHaveLength(0);
    });
  });

  it('caps an explicit limit at 50', async () => {
    await withApp(async (server) => {
      await server.inject({ method: 'GET', url: '/api/auth/sessions?limit=200' });
      await server.inject({ method: 'GET', url: '/api/auth/sessions?limit=500' });
      expect(queries.map((item) => item.params.at(-1))).toEqual([50, 50]);
    });
  });
});
