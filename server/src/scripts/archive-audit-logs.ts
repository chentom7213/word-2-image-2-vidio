import { pool } from '../db/pool.js';
import { archiveAuditLogs, parseArchiveArgs, type ArchiveReport } from './archive-audit-logs-lib.js';

const USAGE = `用法: npm run audit:archive -- [--apply] [--retention-days N]

默认 dry-run：只统计早于保留天数的 audit_logs 行，不写入、不删除。
--apply 才把这些行插入 audit_logs_archive，并在同一事务里从热表删除。
插入使用原主键；归档表已有该主键时不会再插一份。
保留天数默认 180。数据库连不上或中途失败会退出，并且不会提交删除。`;

function printReport(report: ArchiveReport): void {
  console.log(`审计日志冷归档 · ${report.mode}`);
  console.log(`保留 ${report.retentionDays} 天，截止 ${report.cutoff} UTC`);
  console.log(`热表中早于截止时间的行：${report.expired}`);
  if (report.mode === 'apply') {
    console.log(`写入归档 ${report.inserted} 行，从热表删除 ${report.deleted} 行。`);
    return;
  }
  console.log('未写入归档，未删除热表行。确认后执行: npm run audit:archive -- --apply');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseArchiveArgs(argv);
  // A refused connection throws here, before any archive statement.
  const conn = await pool.getConnection();
  try {
    printReport(await archiveAuditLogs(conn, args));
  } finally {
    conn.release();
  }
}

main()
  .catch((error) => {
    console.error(`审计日志归档失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
