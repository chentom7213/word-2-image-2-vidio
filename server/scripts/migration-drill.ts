/**
 * Migration runner drill. Proves the properties that matter operationally.
 *
 * Uses throwaway databases so it never touches dev/prod data:
 *
 *   npm run drill:migrations
 *
 * Assertion messages are intentionally ASCII: this file previously got mangled
 * by a console code-page write, and keeping it ASCII makes that impossible.
 */
import mysql from 'mysql2/promise';
import { env } from '../src/env.js';
import { loadMigrations, migrate, parseVersion } from '../src/db/migrate.js';
import { applyUtcSession } from '../src/db/session-tz.js';

let passed = 0;
let failed = 0;
const ok = (s: string, d = '') => (passed++, console.log(`  [ok] ${s}${d ? ` - ${d}` : ''}`));
const bad = (s: string, d = '') => (failed++, console.error(`  [FAIL] ${s}${d ? ` - ${d}` : ''}`));
const assert = (c: unknown, m: string): asserts c => {
  if (!c) throw new Error(m);
};
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    ok(name, (await fn()) ?? '');
  } catch (e) {
    bad(name, e instanceof Error ? e.message : String(e));
  }
}

const DRILL_DB = `benchu_migrate_drill_${Date.now().toString(36)}`;

/**
 * The drill creates throwaway databases, which needs CREATE/DROP DATABASE. The
 * application user does not have that (nor should it), so default to the dev
 * instance's passwordless root and allow an override elsewhere.
 */
const DRILL_USER = process.env.DRILL_DB_USER ?? 'root';
const DRILL_PASSWORD = process.env.DRILL_DB_PASSWORD ?? '';

async function admin() {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: DRILL_USER,
    password: DRILL_PASSWORD,
    multipleStatements: true,
  });
  await applyUtcSession(conn);
  return conn;
}

async function dbConn(database: string) {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: DRILL_USER,
    password: DRILL_PASSWORD,
    database,
    multipleStatements: true,
  });
  await applyUtcSession(conn);
  return conn;
}

/** Points the runner at another database for the duration of `fn`. */
async function withDb<T>(database: string, fn: () => Promise<T>): Promise<T> {
  const prev = env.db.database;
  (env.db as { database: string }).database = database;
  try {
    return await fn();
  } finally {
    (env.db as { database: string }).database = prev;
  }
}

/**
 * Creates a throwaway database AND grants the application user access to it.
 *
 * The grant matters: `migrate()` connects as the app user (as it does in
 * production), so a database created by root without a grant would fail with
 * "Access denied" — which is what this drill originally tripped over.
 */
async function createDb(name: string) {
  const r = await admin();
  try {
    await r.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [grants] = await r.query<any[]>(
      "SELECT user, host FROM mysql.user WHERE user = ? LIMIT 1",
      [env.db.user],
    );
    if (grants.length > 0) {
      // The app user exists, so provision it exactly like a real deploy would.
      await r.query(
        `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${env.db.user}'@'${grants[0].host}'`,
      );
      await r.query('FLUSH PRIVILEGES');
    }
  } finally {
    await r.end();
  }
}

async function dropDb(name: string) {
  const r = await admin();
  try {
    await r.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await r.end();
  }
}

async function main() {
  console.log(`> Migration drill (temp db ${DRILL_DB})`);

  await createDb(DRILL_DB);

  try {
    await check('filename parsing and version ordering', async () => {
      const migrations = loadMigrations();
      assert(migrations.length >= 2, `only ${migrations.length} migrations found`);
      assert(migrations[0].version === '0001', `first version is ${migrations[0].version}`);
      assert(parseVersion('README.md') === null, 'README.md must not be treated as a migration');
      assert(parseVersion('3_add.sql') === null, '3_add.sql has an invalid version format');
      const versions = migrations.map((m) => m.version);
      assert(
        JSON.stringify(versions) === JSON.stringify([...versions].sort()),
        `migrations are not sorted: ${versions.join(',')}`,
      );
      return migrations.map((m) => m.file).join(', ');
    });

    await check('full migration of an empty database', async () => {
      const { applied } = await withDb(DRILL_DB, () => migrate());
      assert(applied.length >= 2, `only ${applied.length} applied`);

      const conn = await dbConn(DRILL_DB);
      const [tables] = await conn.query<any[]>(
        'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      );
      const names = new Set(tables.map((r) => String(r.t)));
      const expected = [
        'users',
        'generation_tasks',
        'task_outputs',
        'assets',
        'credit_transactions',
        'organizations',
        'memberships',
        'api_keys',
        'audit_logs',
        'refresh_tokens',
        'model_registry',
        'plans',
        'credit_packs',
        'orders',
        'payment_events',
        'monthly_credit_grants',
        'oidc_identities',
        'canvas_documents',
        'audit_logs_archive',
        'schema_migrations',
      ];
      const missing = expected.filter((t) => !names.has(t));
      assert(missing.length === 0, `missing tables: ${missing.join(', ')}`);

      const [cols] = await conn.query<any[]>(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks'`,
      );
      const colNames = new Set(cols.map((r) => String(r.c)));
      for (const c of ['org_id', 'idempotency_key', 'heartbeat_at', 'refunded_at', 'cost_actual']) {
        assert(colNames.has(c), `generation_tasks is missing column ${c}`);
      }
      await conn.end();
      return `${names.size} tables`;
    });

    await check('re-running is a no-op (idempotent)', async () => {
      const { applied } = await withDb(DRILL_DB, () => migrate());
      assert(applied.length === 0, `re-run applied ${applied.join(', ')}`);
      return '0 applied';
    });

    await check('ledger records version, checksum and duration', async () => {
      const conn = await dbConn(DRILL_DB);
      const [rows] = await conn.query<any[]>('SELECT * FROM schema_migrations ORDER BY version');
      assert(rows.length >= 2, `ledger has only ${rows.length} rows`);
      assert(rows.every((r) => /^[0-9a-f]{64}$/.test(String(r.checksum))), 'checksum not recorded');
      await conn.end();
      return rows.map((r) => `${r.version}(${r.execution_ms}ms)`).join(' ');
    });

    await check('edited applied migration is rejected (drift detection)', async () => {
      const conn = await dbConn(DRILL_DB);
      await conn.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?', [
        '0'.repeat(64),
        '0002',
      ]);
      await conn.end();

      let threw = false;
      try {
        await withDb(DRILL_DB, () => migrate());
      } catch (err) {
        threw = true;
        assert(/checksum/.test(String(err)), `unexpected error: ${String(err)}`);
      }
      assert(threw, 'drift was not detected');
      return 'drift blocked';
    });

    await check('--to limits the range (staged rollout)', async () => {
      const partial = `${DRILL_DB}_partial`;
      await createDb(partial);
      try {
        const { applied, skipped } = await withDb(partial, () => migrate({ to: '0001' }));
        assert(applied.length === 1, `applied ${applied.length}`);
        assert(skipped.length >= 1, 'nothing was skipped');

        const conn = await dbConn(partial);
        const [orders] = await conn.query<any[]>(
          `SELECT 1 FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' LIMIT 1`,
        );
        assert(orders.length === 0, 'table orders was created too early');
        const [users] = await conn.query<any[]>(
          `SELECT 1 FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' LIMIT 1`,
        );
        assert(users.length === 1, 'table users was not created');
        await conn.end();
        return `applied ${applied.length}, skipped ${skipped.length}`;
      } finally {
        await dropDb(partial);
      }
    });

    await check('existing database is adopted, 0001 not replayed', async () => {
      const legacy = `${DRILL_DB}_legacy`;
      await createDb(legacy);

      try {
        // Build a faithful "pre-versioning deployment": run the baseline once,
        // then delete the ledger row — exactly the state of a database that was
        // created by the old schema.sql before this runner existed.
        await withDb(legacy, () => migrate({ to: '0001' }));
        const seed = await dbConn(legacy);
        await seed.query('DELETE FROM schema_migrations WHERE version = ?', ['0001']);
        await seed.end();

        const { applied } = await withDb(legacy, () => migrate());
        const conn = await dbConn(legacy);
        const [rows] = await conn.query<any[]>(
          'SELECT version, execution_ms FROM schema_migrations ORDER BY version',
        );
        const baseline = rows.find((x) => x.version === '0001');
        assert(baseline, '0001 was not recorded');
        assert(
          Number(baseline.execution_ms) === 0,
          `0001 was actually executed (${baseline.execution_ms}ms), expected adoption`,
        );
        await conn.end();
        return `adopted 0001, applied ${applied.length} more`;
      } finally {
        await dropDb(legacy);
      }
    });

    /**
     * The adoption gate must require EVERY baseline table. Checking only a
     * sample lets a half-built database be adopted, after which the missing
     * tables are never created and 0002 fails on them.
     */
    await check('half-built database is NOT adopted (missing tables created)', async () => {
      const half = `${DRILL_DB}_halfbuilt`;
      await createDb(half);
      const seed = await dbConn(half);
      await seed.query(`
        CREATE TABLE users (
          id CHAR(36) PRIMARY KEY, email VARCHAR(190) UNIQUE, password_hash VARCHAR(255),
          display_name VARCHAR(80), credits INT NOT NULL DEFAULT 1000,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        CREATE TABLE generation_tasks (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL)
          ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      await seed.end();

      try {
        await withDb(half, () => migrate());
        const conn = await dbConn(half);
        const [rows] = await conn.query<any[]>(
          `SELECT execution_ms FROM schema_migrations WHERE version = '0001'`,
        );
        assert(rows.length === 1, '0001 was not recorded');
        assert(Number(rows[0].execution_ms) > 0, '0001 was adopted despite missing tables');

        const [t] = await conn.query<any[]>(
          `SELECT 1 FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' LIMIT 1`,
        );
        assert(t.length === 1, 'audit_logs was never created');
        await conn.end();
        return 'ran 0001, created the missing tables';
      } finally {
        await dropDb(half);
      }
    });
  } finally {
    await dropDb(DRILL_DB);
  }

  console.log(`\nResult: ${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('migration drill failed:', err);
  process.exit(1);
});
