import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../env.js';
import { applyUtcSession } from './session-tz.js';

/**
 * Versioned schema migrations.
 *
 * Why this replaces the old "idempotent schema.sql + column sniffing" approach:
 * that was safe to *add* things but had no record of what had run, so there was
 * no way to know whether an environment was current, and no path to a rollback.
 *
 * Design notes, each of which matters operationally:
 *
 *  - **Checksums.** Every applied migration stores a hash of its file. If a
 *    shipped file is edited, the next run fails loudly instead of silently
 *    diverging across environments. Fix forward with a new migration.
 *
 *  - **MySQL DDL is not transactional.** Every DDL statement causes an implicit
 *    commit, so a mid-file failure leaves partial state and cannot be rolled
 *    back. Therefore every migration MUST be written idempotently (guarded
 *    CREATE / conditional ALTER), which is what makes a retry safe.
 *
 *  - **Baseline adoption.** A database created before this runner existed has
 *    tables but no `schema_migrations` row. Rather than replaying 0001 against
 *    production, the runner records it as adopted when the baseline tables are
 *    already present.
 *
 * Usage:
 *   npm run db:migrate              apply everything pending
 *   npm run db:migrate -- --status  show applied/pending
 *   npm run db:migrate -- --dry-run list what would run
 *   npm run db:migrate -- --to 0002 stop after 0002
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export type MigrationFile = {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
};

export type AppliedRow = {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
};

/** Parses `0002_plans_and_orders.sql` → version `0002`. */
export function parseVersion(filename: string): { version: string; name: string } | null {
  const m = /^(\d{4})_([a-z0-9_]+)\.sql$/i.exec(filename);
  if (!m) return null;
  return { version: m[1], name: m[2] };
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => parseVersion(f) !== null)
    .sort();

  const out: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const parsed = parseVersion(file)!;
    if (seen.has(parsed.version)) {
      throw new Error(`迁移版本重复: ${parsed.version}`);
    }
    seen.add(parsed.version);
    const sql = readFileSync(join(dir, file), 'utf8');
    out.push({
      version: parsed.version,
      name: parsed.name,
      file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return out;
}

async function tableExists(conn: mysql.Connection, table: string): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table],
  );
  return rows.length > 0;
}

async function ensureLedger(conn: mysql.Connection): Promise<void> {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      VARCHAR(16)  NOT NULL PRIMARY KEY,
      name         VARCHAR(160) NOT NULL,
      checksum     CHAR(64)     NOT NULL,
      execution_ms INT          NOT NULL DEFAULT 0,
      applied_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedMigrations(conn: mysql.Connection): Promise<Map<string, AppliedRow>> {
  const [rows] = await conn.query<any[]>('SELECT * FROM schema_migrations ORDER BY version');
  const map = new Map<string, AppliedRow>();
  for (const r of rows) map.set(String(r.version), r as AppliedRow);
  return map;
}

/**
 * Tables a migration creates, parsed from its own `CREATE TABLE` statements.
 *
 * Deriving this from the file (instead of a hand-maintained list) means the
 * adoption check can never drift out of sync with the schema it is checking.
 */
export function tablesCreatedBy(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/gi)].map((m) => m[1]);
}

/**
 * An existing database with the baseline tables but an empty ledger is *adopted*
 * rather than replayed, so a pre-versioning deployment needs no rebuild.
 *
 * The check requires EVERY table the baseline creates, not a sample: a
 * half-initialised database must fall through to a real run, otherwise the
 * missing tables are never created and later migrations fail on them.
 */
async function adoptBaselineIfNeeded(conn: mysql.Connection, migrations: MigrationFile[]): Promise<boolean> {
  const ledger = await appliedMigrations(conn);
  if (ledger.size > 0) return false;

  const baseline = migrations[0];
  if (!baseline) return false;

  const required = tablesCreatedBy(baseline.sql);
  if (required.length === 0) return false;

  for (const t of required) {
    if (!(await tableExists(conn, t))) return false;
  }

  await conn.query(
    'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, 0)',
    [baseline.version, baseline.name, baseline.checksum],
  );
  console.log(`• 检测到既有数据库（${required.length} 张基线表齐全），已将 ${baseline.file} 记录为已应用`);
  return true;
}

async function runSqlFile(conn: mysql.Connection, sql: string): Promise<void> {
  // `multipleStatements` is enabled on this connection, so the whole file runs
  // as one script. Keep files free of `DELIMITER` blocks for that reason.
  await conn.query(sql);
}

async function connect(): Promise<mysql.Connection> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });
  await applyUtcSession(conn);
  return conn;
}

export async function migrate(opts: { to?: string; dryRun?: boolean } = {}): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const migrations = loadMigrations();
  const conn = await connect();

  try {
    await ensureLedger(conn);
    await adoptBaselineIfNeeded(conn, migrations);

    const ledger = await appliedMigrations(conn);
    const applied: string[] = [];
    const skipped: string[] = [];

    // Drift detection: a shipped file that changed after being applied means
    // environments have silently diverged.
    for (const m of migrations) {
      const row = ledger.get(m.version);
      if (row && row.checksum !== m.checksum) {
        throw new Error(
          `迁移 ${m.file} 已应用但文件内容被修改（checksum 不一致）。` +
            `请改用新的迁移文件修复，不要编辑已发布的迁移。`,
        );
      }
    }

    for (const m of migrations) {
      if (ledger.has(m.version)) continue;
      if (opts.to && m.version > opts.to) {
        skipped.push(m.file);
        continue;
      }

      if (opts.dryRun) {
        console.log(`  (dry-run) 将应用 ${m.file}`);
        skipped.push(m.file);
        continue;
      }

      const started = Date.now();
      console.log(`▶ 应用 ${m.file}`);
      await runSqlFile(conn, m.sql);
      const ms = Date.now() - started;

      await conn.query(
        'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)',
        [m.version, m.name, m.checksum, ms],
      );
      applied.push(m.file);
      console.log(`✔ ${m.file} (${ms}ms)`);
    }

    return { applied, skipped };
  } finally {
    await conn.end();
  }
}

async function status(): Promise<void> {
  const migrations = loadMigrations();
  const conn = await connect();
  try {
    await ensureLedger(conn);
    const ledger = await appliedMigrations(conn);
    console.log(`\n数据库: ${env.db.database}@${env.db.host}:${env.db.port}\n`);
    for (const m of migrations) {
      const row = ledger.get(m.version);
      if (!row) {
        console.log(`  [ pending ] ${m.file}`);
      } else {
        const drifted = row.checksum !== m.checksum ? '  ⚠ 文件已变更' : '';
        console.log(`  [ applied ] ${m.file}  ${row.applied_at}  ${row.execution_ms}ms${drifted}`);
      }
    }
    const pending = migrations.filter((m) => !ledger.has(m.version)).length;
    console.log(`\n共 ${migrations.length} 个迁移，${pending} 个待应用\n`);
  } finally {
    await conn.end();
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--status')) {
    await status();
    return;
  }

  const toIdx = argv.indexOf('--to');
  const to = toIdx >= 0 ? argv[toIdx + 1] : undefined;
  const dryRun = argv.includes('--dry-run');

  const { applied, skipped } = await migrate({ to, dryRun });
  if (applied.length === 0) {
    console.log(
      dryRun
        ? `\n(dry-run) ${skipped.length} 个迁移待应用`
        : '\n✔ 数据库已是最新，无待应用迁移',
    );
  } else {
    console.log(`\n✅ 已应用 ${applied.length} 个迁移`);
  }
}

// `init.ts` imports `migrate()` as a library.  Do not execute the CLI entry
// point on import, otherwise init launches a second concurrent migration run.
const invokedAsCli = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedAsCli) {
  main().catch((err) => {
    console.error('❌ 迁移失败:', err.message ?? err);
    process.exit(1);
  });
}
