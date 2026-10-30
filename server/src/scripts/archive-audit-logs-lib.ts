/** Default age after which an audit row may leave the hot table. */
export const DEFAULT_RETENTION_DAYS = 180;

const AUDIT_COLUMNS = 'id, org_id, user_id, action, target, ip, ua, meta, created_at';

/** Read-only count. Dry-run stops after this statement. */
export const COUNT_EXPIRED_SQL =
  'SELECT COUNT(*) AS expired_count FROM audit_logs WHERE created_at < ?';

/**
 * Copy expired hot rows. IGNORE keeps a second run from inserting another
 * copy when the primary key is already present in the archive.
 * FOR UPDATE locks the selected hot rows until the matching delete commits.
 */
export const INSERT_ARCHIVE_SQL =
  `INSERT IGNORE INTO audit_logs_archive (${AUDIT_COLUMNS}) ` +
  `SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE created_at < ? FOR UPDATE`;

/**
 * Delete only hot rows that now exist in the archive. A failed insert rolls
 * back this delete with it, so a database error cannot drop the only copy.
 */
export const DELETE_ARCHIVED_SQL =
  'DELETE hot FROM audit_logs hot ' +
  'INNER JOIN audit_logs_archive archived ON archived.id = hot.id ' +
  'WHERE hot.created_at < ?';

export type ArchiveConnection = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

export type ArchiveReport = {
  mode: 'dry-run' | 'apply';
  retentionDays: number;
  cutoff: string;
  expired: number;
  inserted: number;
  deleted: number;
};

export function parseArchiveArgs(argv: string[]): { apply: boolean; retentionDays: number } {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--retention-days') {
      i += 1;
      continue;
    }
    if (arg !== '--apply') throw new Error(`未知参数: ${arg}`);
  }
  return {
    apply: argv.includes('--apply'),
    retentionDays: integerFlag(argv, '--retention-days', DEFAULT_RETENTION_DAYS),
  };
}

export function retentionCutoff(now: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error('--retention-days 必须是非负整数');
  }
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

/** UTC wall time, which matches the pool's timezone: 'Z' datetime binding. */
export function formatMysqlDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('无效的截止时间');
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Move audit_logs rows older than the retention window into audit_logs_archive.
 * Without `apply`, this only counts. The insert and delete share one
 * transaction; a connection or statement failure rejects and leaves the hot
 * table unchanged.
 */
export async function archiveAuditLogs(
  conn: ArchiveConnection,
  options: { apply: boolean; retentionDays: number; now?: Date },
): Promise<ArchiveReport> {
  const now = options.now ?? new Date();
  const cutoff = formatMysqlDateTime(retentionCutoff(now, options.retentionDays));
  const expired = await countExpired(conn, cutoff);
  if (!options.apply) {
    return {
      mode: 'dry-run',
      retentionDays: options.retentionDays,
      cutoff,
      expired,
      inserted: 0,
      deleted: 0,
    };
  }

  await conn.beginTransaction();
  try {
    const inserted = affectedRows(await conn.query(INSERT_ARCHIVE_SQL, [cutoff]));
    const deleted = affectedRows(await conn.query(DELETE_ARCHIVED_SQL, [cutoff]));
    await conn.commit();
    return {
      mode: 'apply',
      retentionDays: options.retentionDays,
      cutoff,
      expired,
      inserted,
      deleted,
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  }
}

async function countExpired(conn: ArchiveConnection, cutoff: string): Promise<number> {
  const result = await conn.query(COUNT_EXPIRED_SQL, [cutoff]);
  const rows = Array.isArray(result) ? result[0] : result;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const value = (rows[0] as { expired_count?: number | string }).expired_count;
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) throw new Error('无法读取待归档行数');
  return count;
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== 'object' || !('affectedRows' in header)) return 0;
  const count = Number((header as { affectedRows: number }).affectedRows);
  return Number.isFinite(count) ? count : 0;
}

function integerFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${flag} 缺少数值`);
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} 必须是非负整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} 必须是非负整数`);
  return value;
}
