/**
 * Delete upload objects that are at least 365 days old.
 *
 * Eligible keys are only `uploads/`, `infrequent/uploads/`, and
 * `archive/uploads/`. `outputs/` and `retention-hold/` are never selected.
 * A key that is still referenced is still eligible. Plan id is not consulted.
 *
 * Age comes from the earliest parseable `created_at` among `assets.url`,
 * `task_outputs.object_key`, `generation_tasks.result_url`, and `poster_url`.
 * A key that appears in those rows but has no parseable timestamp is skipped.
 * A key the database does not mention uses the listed file mtime.
 *
 * Applying a candidate runs one transaction of four fixed statements, then
 * deletes the file. `generation_refs.asset_id` is ON DELETE CASCADE from
 * `assets`, so this module does not emit a second delete. Canvas JSON is not
 * updated.
 */

export const DAY_MS = 86_400_000;
export const UPLOAD_EXPIRY_DAYS = 365;

export const OUTPUT_AGES_SQL = 'SELECT object_key, created_at FROM task_outputs';
export const ASSET_AGES_SQL = 'SELECT url AS object_key, created_at FROM assets';
export const LEGACY_AGES_SQL =
  'SELECT result_url, poster_url, created_at FROM generation_tasks WHERE result_url IS NOT NULL OR poster_url IS NOT NULL';

export const DELETE_TASK_OUTPUTS_SQL = 'DELETE FROM task_outputs WHERE object_key = ?';
export const DELETE_ASSETS_SQL = 'DELETE FROM assets WHERE url = ?';
export const CLEAR_RESULT_URL_SQL = 'UPDATE generation_tasks SET result_url = NULL WHERE result_url = ?';
export const CLEAR_POSTER_URL_SQL = 'UPDATE generation_tasks SET poster_url = NULL WHERE poster_url = ?';

/** The only statements --apply may run. No concatenation, no canvas write, no generation_refs delete. */
export const DETACH_SQL = [
  DELETE_TASK_OUTPUTS_SQL,
  DELETE_ASSETS_SQL,
  CLEAR_RESULT_URL_SQL,
  CLEAR_POSTER_URL_SQL,
] as const;

const ELIGIBLE_PREFIXES = ['uploads/', 'infrequent/uploads/', 'archive/uploads/'] as const;

export type SqlQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
export type SqlExecute = (sql: string, params: readonly [string]) => Promise<unknown>;

export type UploadExpiryConnection = {
  execute: SqlExecute;
};

export type UploadExpiryTransaction = (
  fn: (conn: UploadExpiryConnection) => Promise<void>,
) => Promise<void>;

export type ListedUpload = {
  objectKey: string;
  modifiedAtMs: number;
};

export type DatabaseObject = {
  objectKey: string;
  createdAtMs: number | null;
};

export type AgeSource = 'database' | 'mtime';

export type UploadExpiryCandidate = {
  objectKey: string;
  ageDays: number;
  ageSource: AgeSource;
};

export type UploadExpiryFailure = {
  objectKey: string;
  phase: 'transaction' | 'file';
  message: string;
};

export type UploadExpiryReport = {
  mode: 'dry-run' | 'apply';
  enabled: boolean;
  planned: UploadExpiryCandidate[];
  deleted: string[];
  failures: UploadExpiryFailure[];
};

export interface UploadExpiryStore {
  list(): ListedUpload[];
  /** Delete one ordinary file. Must refuse symlinks and keys outside the upload prefixes. */
  remove(objectKey: string): void;
}

export type UploadExpiryCommand = 'dry-run' | 'apply';

export type RunOptions = {
  command: UploadExpiryCommand;
  enabled: boolean;
  /** `STORAGE_DRIVER`. Only `s3` is refused. */
  driver?: string | undefined;
  now: number;
  store: UploadExpiryStore;
  loadAges: () => Promise<DatabaseObject[]>;
  transaction: UploadExpiryTransaction;
};

type AgeRow = { object_key?: unknown; created_at?: unknown };
type LegacyRow = { result_url?: unknown; poster_url?: unknown; created_at?: unknown };

/** Exact `1` only. `true`, `yes`, `"1 "`, and empty stay off. */
export function readUploadExpiryEnabled(env: { STORAGE_UPLOAD_EXPIRY?: string | undefined }): boolean {
  return env.STORAGE_UPLOAD_EXPIRY === '1';
}

export function assertLocalStorageDriver(driver: string | undefined): void {
  const normalized = (driver ?? 'local').trim().toLowerCase();
  if (normalized === 's3') {
    throw new Error('storage:upload-expiry 只用于 STORAGE_DRIVER=local；S3/OSS 请改用桶生命周期规则');
  }
}

export function parseUploadExpiryArgs(argv: string[]): { command: UploadExpiryCommand; json: boolean } {
  const known = new Set(['--apply', '--json']);
  for (const arg of argv) {
    if (!known.has(arg)) throw new Error(`未知参数: ${arg}`);
  }
  return {
    command: argv.includes('--apply') ? 'apply' : 'dry-run',
    json: argv.includes('--json'),
  };
}

export function isFixedDetachSql(sql: string): boolean {
  return (DETACH_SQL as readonly string[]).includes(sql);
}

export function isEligibleUploadKey(value: string | null | undefined): value is string {
  if (!isSafeObjectKey(value)) return false;
  return ELIGIBLE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function selectExpiredUploads(
  listed: readonly ListedUpload[],
  ages: readonly DatabaseObject[],
  now: number,
): UploadExpiryCandidate[] {
  if (!Number.isFinite(now)) throw new Error('无效的当前时间');
  const births = indexBirths(ages);
  const seen = new Set<string>();
  const planned: UploadExpiryCandidate[] = [];
  for (const item of listed) {
    if (!item || typeof item.objectKey !== 'string' || seen.has(item.objectKey)) continue;
    seen.add(item.objectKey);
    if (!isEligibleUploadKey(item.objectKey)) continue;
    const birth = birthOf(item, births);
    if (birth == null) continue;
    const ageMs = now - birth.atMs;
    if (!Number.isFinite(ageMs) || ageMs < UPLOAD_EXPIRY_DAYS * DAY_MS) continue;
    planned.push({
      objectKey: item.objectKey,
      ageDays: Math.floor(ageMs / DAY_MS),
      ageSource: birth.source,
    });
  }
  planned.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
  return planned;
}

/**
 * Run the four fixed statements. The asset delete cascades `generation_refs`.
 * Callers must not add another DELETE, and must not update canvas JSON.
 */
export async function detachUploadReferences(execute: SqlExecute, objectKey: string): Promise<void> {
  if (!isEligibleUploadKey(objectKey)) throw new Error(`拒绝删除非上传对象: ${objectKey}`);
  for (const sql of DETACH_SQL) {
    if (!isFixedDetachSql(sql)) throw new Error('拒绝执行未固定的删除语句');
    await execute(sql, [objectKey]);
  }
}

export async function loadUploadAges(query: SqlQuery): Promise<DatabaseObject[]> {
  const outputs = await fetchRows<AgeRow>(query, OUTPUT_AGES_SQL);
  const assets = await fetchRows<AgeRow>(query, ASSET_AGES_SQL);
  const legacy = await fetchRows<LegacyRow>(query, LEGACY_AGES_SQL);
  return [
    ...outputs.map((row) => toAge(row, readKey(row, 'object_key'))),
    ...assets.map((row) => toAge(row, readKey(row, 'object_key'))),
    ...legacy.flatMap((row) => [readKey(row, 'result_url'), readKey(row, 'poster_url')]
      .filter((key): key is string => key != null)
      .map((key) => toAge(row, key))),
  ].filter((row): row is DatabaseObject => row != null);
}

export async function runUploadExpiry(options: RunOptions): Promise<UploadExpiryReport> {
  if (!Number.isFinite(options.now)) throw new Error('无效的当前时间');
  assertLocalStorageDriver(options.driver);
  if (options.command === 'apply' && !options.enabled) {
    throw new Error('STORAGE_UPLOAD_EXPIRY 不是 1，拒绝执行 apply，未删除任何文件，未修改数据库');
  }

  const ages = await loadDatabaseOrFail(options.loadAges);
  const listed = listOrFail(options.store);
  const planned = selectExpiredUploads(listed, ages, options.now);
  if (options.command === 'dry-run') {
    return { mode: 'dry-run', enabled: options.enabled, planned, deleted: [], failures: [] };
  }
  const applied = await applyDeletes(options, planned);
  return { mode: 'apply', enabled: options.enabled, planned, ...applied };
}

/** MySQL `dateStrings` values are UTC wall times (`timezone: 'Z'`). */
export function createdAtMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const iso = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexBirths(rows: readonly DatabaseObject[]): Map<string, number | null> {
  const births = new Map<string, number | null>();
  for (const row of rows) {
    if (!row || typeof row.objectKey !== 'string' || !isSafeObjectKey(row.objectKey)) continue;
    rememberBirth(births, row.objectKey, row.createdAtMs);
  }
  return births;
}

function rememberBirth(births: Map<string, number | null>, objectKey: string, createdAtMsValue: number | null): void {
  const finite = typeof createdAtMsValue === 'number' && Number.isFinite(createdAtMsValue);
  if (!births.has(objectKey)) {
    births.set(objectKey, finite ? createdAtMsValue : null);
    return;
  }
  if (!finite) return;
  const known = births.get(objectKey);
  births.set(objectKey, known == null ? createdAtMsValue : Math.min(known, createdAtMsValue));
}

/**
 * A known key with no parseable timestamp is skipped, even when the file
 * mtime is old. Keys the database never mentions use mtime.
 */
function birthOf(
  item: ListedUpload,
  births: ReadonlyMap<string, number | null>,
): { atMs: number; source: AgeSource } | null {
  if (births.has(item.objectKey)) {
    const created = births.get(item.objectKey);
    if (created == null) return null;
    return { atMs: created, source: 'database' };
  }
  if (typeof item.modifiedAtMs === 'number' && Number.isFinite(item.modifiedAtMs)) {
    return { atMs: item.modifiedAtMs, source: 'mtime' };
  }
  return null;
}

async function applyDeletes(
  options: RunOptions,
  planned: readonly UploadExpiryCandidate[],
): Promise<Pick<UploadExpiryReport, 'deleted' | 'failures'>> {
  const deleted: string[] = [];
  const failures: UploadExpiryFailure[] = [];
  for (const item of planned) {
    if (!isEligibleUploadKey(item.objectKey)) {
      failures.push({ objectKey: item.objectKey, phase: 'transaction', message: '拒绝删除非上传对象' });
      continue;
    }
    try {
      await options.transaction(async (conn) => {
        await detachUploadReferences(conn.execute, item.objectKey);
      });
    } catch (error) {
      failures.push({ objectKey: item.objectKey, phase: 'transaction', message: errorMessage(error) });
      continue;
    }
    try {
      options.store.remove(item.objectKey);
      deleted.push(item.objectKey);
    } catch (error) {
      failures.push({ objectKey: item.objectKey, phase: 'file', message: errorMessage(error) });
    }
  }
  return { deleted, failures };
}

async function loadDatabaseOrFail(load: () => Promise<DatabaseObject[]>): Promise<DatabaseObject[]> {
  try {
    const rows = await load();
    if (!Array.isArray(rows)) throw new Error('数据库查询结果无效');
    return rows;
  } catch (error) {
    throw new Error(`数据库查询失败，已中止，未删除任何文件，未修改数据库: ${errorMessage(error)}`);
  }
}

function listOrFail(store: UploadExpiryStore): ListedUpload[] {
  try {
    const listed = store.list();
    if (!Array.isArray(listed)) throw new Error('对象列举结果无效');
    return listed;
  } catch (error) {
    throw new Error(`对象列举失败，已中止，未删除任何文件，未修改数据库: ${errorMessage(error)}`);
  }
}

function isAgeSql(sql: string): boolean {
  return sql === OUTPUT_AGES_SQL || sql === ASSET_AGES_SQL || sql === LEGACY_AGES_SQL;
}

async function fetchRows<T>(query: SqlQuery, sql: string): Promise<T[]> {
  if (!isAgeSql(sql) || !sql.startsWith('SELECT ')) throw new Error('拒绝执行未知查询');
  const rows = await query<T>(sql);
  if (!Array.isArray(rows)) throw new Error('数据库查询结果无效');
  return rows;
}

function toAge(row: object, objectKey: string | null): DatabaseObject | null {
  const created = readCreatedAt(row);
  if (objectKey == null || !isSafeObjectKey(objectKey)) return null;
  return { objectKey, createdAtMs: created };
}

function readCreatedAt(row: object): number | null {
  if (!Object.prototype.hasOwnProperty.call(row, 'created_at')) throw new Error('数据库查询缺少 created_at，已中止');
  return createdAtMs((row as Record<string, unknown>).created_at);
}

function readKey(row: object, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`数据库查询缺少 ${field}，已中止`);
  const value = (row as Record<string, unknown>)[field];
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`数据库查询的 ${field} 无效，已中止`);
  return value;
}

function isSafeObjectKey(value: string | null | undefined): value is string {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  if (value.includes('://') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
