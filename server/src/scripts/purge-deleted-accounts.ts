import { pool } from '../db/pool.js';
import { removeObject } from '../services/storage.js';
import {
  asErasureConnection,
  parsePurgeArgs,
  purgeDeletedAccounts,
  type PurgeReport,
} from '../services/account-erasure.js';

const USAGE = `用法: npm run account:purge -- [--apply] [--retention-days N]

默认 dry-run：只报告 deleted_at 已满保留天数（默认 30）的用户，不删除数据，也不删除对象。
--apply 才删除这些用户的生成任务、任务产物、素材和会话，并删除这些行引用的对象键。
然后把邮箱改成不可登录的占位，清掉密码和显示名。用户行、积分流水、订单和支付事件都保留。
数据库失败会退出，并且不会删除对象。`;

function printReport(report: PurgeReport): void {
  console.log(`注销账户清理 · ${report.mode}`);
  console.log(`保留 ${report.retentionDays} 天，截止 ${report.cutoff} UTC`);
  console.log(`已满保留期的注销用户：${report.userIds.length}`);
  for (const id of report.userIds) console.log(`  ${id}`);
  console.log(
    `任务 ${report.tasks}，产物 ${report.outputs}，素材 ${report.assets}，会话 ${report.sessions}，对象 ${report.objectKeys.length}`,
  );
  for (const key of report.objectKeys) console.log(`  object ${key}`);
  if (report.mode === 'apply') {
    console.log(`已匿名化 ${report.anonymized} 个用户。积分流水、订单、支付事件和用户行未删除。`);
    return;
  }
  console.log('未删除数据，未删除对象。确认后执行: npm run account:purge -- --apply');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parsePurgeArgs(argv);
  const conn = await pool.getConnection();
  try {
    const report = await purgeDeletedAccounts(
      asErasureConnection({
        query: (sql, params) => conn.query(sql, params),
        beginTransaction: () => conn.beginTransaction(),
        commit: () => conn.commit(),
        rollback: () => conn.rollback(),
      }),
      { apply: args.apply, retentionDays: args.retentionDays },
      { remove: (key) => removeObject(key) },
    );
    printReport(report);
  } finally {
    conn.release();
  }
}

main()
  .catch((error) => {
    console.error(`注销账户清理失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
