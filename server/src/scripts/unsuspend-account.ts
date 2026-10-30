import { pathToFileURL } from 'node:url';
import { pool } from '../db/pool.js';

const USAGE = `用法: npm run account:unsuspend -- [--apply --user <id>]

默认 dry-run：不修改数据库。
只有环境变量 ACCOUNT_UNSUSPEND 精确等于 1，并且同时带上 --apply --user <id>，才会把该用户的 suspended_at 清空。
不清积分、不删用户、订单或流水，也不恢复已撤销的刷新令牌。`;

export const SELECT_SUSPENDED_USER_SQL =
  'SELECT id, suspended_at, credits FROM users WHERE id = ? LIMIT 1';

export const CLEAR_SUSPENDED_SQL = 'UPDATE users SET suspended_at = NULL WHERE id = ?';

export type UnsuspendQuery = (sql: string, params?: readonly unknown[]) => Promise<unknown>;

export type UnsuspendReport = {
  mode: 'dry-run' | 'apply';
  userId: string | null;
  found: boolean;
  suspendedAt: string | null;
  cleared: boolean;
};

type UnsuspendArgs = { apply: boolean; userId: string | null };

export function parseUnsuspendArgs(argv: string[]): UnsuspendArgs {
  let apply = false;
  let userId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--user') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--user 缺少用户 id');
      userId = value;
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return { apply, userId };
}

/** Apply is refused unless the switch is exactly the string "1". */
export function assertUnsuspendApplyAllowed(switchValue: string | undefined, apply: boolean): void {
  if (!apply) return;
  if (switchValue !== '1') {
    throw new Error('解除停用未执行：ACCOUNT_UNSUSPEND 必须精确等于 1');
  }
}

function readRows(result: unknown): Record<string, unknown>[] {
  const packet = Array.isArray(result) ? result[0] : result;
  if (!Array.isArray(packet)) return [];
  return packet as Record<string, unknown>[];
}

function asText(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

/**
 * Clears `suspended_at` only when apply is set and the switch is exactly "1".
 * Otherwise this selects at most one row and writes nothing.
 */
export async function unsuspendAccount(
  query: UnsuspendQuery,
  input: { apply: boolean; userId: string; switchValue: string | undefined },
): Promise<UnsuspendReport> {
  assertUnsuspendApplyAllowed(input.switchValue, input.apply);
  const rows = readRows(await query(SELECT_SUSPENDED_USER_SQL, [input.userId]));
  const row = rows[0];
  const suspendedAt = row ? asText(row.suspended_at) : null;
  if (!input.apply || !row) {
    return {
      mode: input.apply ? 'apply' : 'dry-run',
      userId: input.userId,
      found: Boolean(row),
      suspendedAt,
      cleared: false,
    };
  }
  await query(CLEAR_SUSPENDED_SQL, [input.userId]);
  return {
    mode: 'apply',
    userId: input.userId,
    found: true,
    suspendedAt,
    cleared: true,
  };
}

export async function runUnsuspend(
  argv: string[],
  switchValue: string | undefined,
  connect: () => Promise<{ query: UnsuspendQuery; release: () => Promise<void> }>,
): Promise<UnsuspendReport> {
  const args = parseUnsuspendArgs(argv);
  assertUnsuspendApplyAllowed(switchValue, args.apply);
  if (!args.userId) {
    if (args.apply) throw new Error('--apply 需要 --user <id>');
    return { mode: 'dry-run', userId: null, found: false, suspendedAt: null, cleared: false };
  }
  const conn = await connect();
  try {
    return await unsuspendAccount(conn.query, {
      apply: args.apply,
      userId: args.userId,
      switchValue,
    });
  } finally {
    await conn.release();
  }
}

function printReport(report: UnsuspendReport): void {
  console.log(`解除停用 · ${report.mode}`);
  if (!report.userId) {
    console.log('未指定 --user，未修改数据库。');
    return;
  }
  if (!report.found) {
    console.log(`未找到用户 ${report.userId}，未修改数据库。`);
    return;
  }
  if (report.mode === 'apply' && report.cleared) {
    console.log(`已清空用户 ${report.userId} 的 suspended_at。积分、订单和流水未改。`);
    return;
  }
  console.log(
    `用户 ${report.userId} 的 suspended_at 为 ${report.suspendedAt ?? '空'}。未修改数据库。确认后执行: ACCOUNT_UNSUSPEND=1 npm run account:unsuspend -- --apply --user ${report.userId}`,
  );
}

function launchedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const report = await runUnsuspend(argv, process.env.ACCOUNT_UNSUSPEND, async () => {
    const conn = await pool.getConnection();
    return {
      query: (sql, params) => conn.query(sql, params as any[]),
      release: async () => {
        conn.release();
      },
    };
  });
  printReport(report);
}

if (launchedAsCli()) {
  main()
    .catch((error) => {
      console.error(`解除停用失败: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
    });
}
