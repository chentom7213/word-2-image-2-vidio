import mysql from 'mysql2/promise';
import { env } from '../src/env.js';
import { applyUtcSession } from '../src/db/session-tz.js';

/**
 * Pre-release helper: forget a migration so it can be re-applied.
 *
 * Why this exists: the checksum guard correctly refuses to run a migration file
 * that changed after being recorded. That is exactly right after a release, but
 * during development a migration is often amended minutes after the local
 * database applied it. This resets ONE version so the amended file runs again.
 *
 * NOT for production. It only deletes the ledger row (and optionally the tables
 * the migration created), and it prints a reminder that seeding must re-run —
 * migrations own STRUCTURE, `db:init` owns DATA, and dropping a table silently
 * loses its seed rows otherwise.
 *
 *   npx tsx scripts/reset-migration.ts 0002 --drop orders,credit_packs,payment_events
 */
const version = process.argv[2];
const dropArg = process.argv.indexOf('--drop');
const tables = dropArg > 0 ? (process.argv[dropArg + 1] ?? '').split(',').filter(Boolean) : [];

if (!version) {
  console.error('用法: reset-migration.ts <version> [--drop t1,t2]');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  multipleStatements: true,
});
await applyUtcSession(conn);

const [rows] = await conn.query<any[]>('SELECT version FROM schema_migrations WHERE version = ?', [
  version,
]);
if (rows.length === 0) {
  console.log(`• ${version} 未记录，无需重置`);
  await conn.end();
  process.exit(0);
}

for (const table of tables) {
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  console.log(`  dropped ${table}`);
}

await conn.query('DELETE FROM schema_migrations WHERE version = ?', [version]);
console.log(`✔ 已移除 ${version} 的账本记录`);

if (tables.length > 0) {
  console.log('⚠️  删表会丢掉种子数据（如套餐/充值包），请随后执行: npm run db:init');
}

await conn.end();
