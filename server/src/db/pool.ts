import mysql from 'mysql2/promise';
import { env } from '../env.js';
import { bindUtcSession } from './session-tz.js';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: true,
  timezone: 'Z',
});

bindUtcSession(pool);

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: any[] = []) {
  const [result] = await pool.query(sql, params);
  return result as mysql.ResultSetHeader;
}

/**
 * Run a set of statements inside a transaction.
 *
 * MySQL picks a deadlock victim under concurrent row-lock contention — the
 * classic case here is two requests locking the same `users` row via
 * `SELECT … FOR UPDATE` while also touching `generation_tasks`. A deadlock is
 * transient by definition, so it is retried with jitter instead of failing the
 * user's paid task.
 */
const DEADLOCK_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const MAX_TX_ATTEMPTS = 4;

export async function withTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err: any) {
      await conn.rollback().catch(() => {});
      const code = String(err?.code ?? '');
      if (DEADLOCK_CODES.has(code) && attempt < MAX_TX_ATTEMPTS) {
        lastErr = err;
        // Exponential backoff with jitter so retries do not collide again.
        const delay = 25 * 2 ** (attempt - 1) + Math.random() * 40;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  throw lastErr ?? new Error('transaction failed');
}
