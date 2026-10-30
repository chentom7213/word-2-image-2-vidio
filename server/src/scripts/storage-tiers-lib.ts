/**
 * Local hot/cold prefix moves for plan §5.4.
 *
 * uploads/  → infrequent at 30 days, archive at 90 days.
 * outputs/  → infrequent at 90 days, archive at 365 days.
 *
 * The longer age wins, so each object is planned for one destination.
 * Keys already under infrequent/, archive/, or retention-hold/ stay put.
 * Plan id and whether anything still references the object do not matter.
 * This module never deletes. Orphan cleanup stays in storage-lifecycle.
 * Free-plan hold stays in storage-plan-retention.
 * After a rename succeeds, apply rewrites that exact object key in the database.
 * Dry-run does not rename and does not rewrite. Zero matching rows is still success.
 * canvas_documents JSON is left untouched, and keys are never updated by substring.
 */

export const DAY_MS = 86_400_000;
export const UPLOAD_INFREQUENT_DAYS = 30;
export const UPLOAD_ARCHIVE_DAYS = 90;
export const OUTPUT_INFREQUENT_DAYS = 90;
export const OUTPUT_ARCHIVE_DAYS = 365;

export const OUTPUT_AGES_SQL = 'SELECT object_key, created_at FROM task_outputs';
export const ASSET_AGES_SQL = 'SELECT url AS object_key, created_at FROM assets';
export const LEGACY_AGES_SQL =
  'SELECT result_url, poster_url, created_at FROM generation_tasks WHERE result_url IS NOT NULL OR poster_url IS NOT NULL';

/** Bound parameters are the new key, then the old key. These strings are never concatenated. */
export const REWRITE_TASK_OUTPUTS_SQL = 'UPDATE task_outputs SET object_key = ? WHERE object_key = ?';
export const REWRITE_ASSETS_SQL = 'UPDATE assets SET url = ? WHERE url = ?';
export const REWRITE_GENERATION_RESULT_SQL = 'UPDATE generation_tasks SET result_url = ? WHERE result_url = ?';
export const REWRITE_GENERATION_POSTER_SQL = 'UPDATE generation_tasks SET poster_url = ? WHERE poster_url = ?';
export const TIER_KEY_REWRITE_SQL = [
  REWRITE_TASK_OUTPUTS_SQL,
  REWRITE_ASSETS_SQL,
  REWRITE_GENERATION_RESULT_SQL,
  REWRITE_GENERATION_POSTER_SQL,
] as const;

export type SqlQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
export type TierKeyExecute = (sql: string, params: [string, string]) => Promise<unknown>;
/** Called with the old key, then the new key, only after that file rename succeeds. */
export type RewriteObjectKey = (fromKey: string, toKey: string) => Promise<void>;

export type ListedObject = {
  objectKey: string;
  modifiedAtMs: number;
};

export type DatabaseObject = {
  objectKey: string;
  createdAtMs: number | null;
};

export type TierName = 'infrequent' | 'archive';

export type TierMove = {
  objectKey: string;
  destinationKey: string;
  tier: TierName;
  ageDays: number;
};

export type TierFailure = { objectKey: string; message: string };

export type TierReport = {
  mode: 'dry-run' | 'apply';
  enabled: boolean;
  planned: TierMove[];
  moved: string[];
  failures: TierFailure[];
};

export interface TierStore {
  list(): ListedObject[];
  /** Rename only. Implementations must not delete the object. */
  move(fromKey: string, toKey: string): void;
}

export type TierCommand = 'dry-run' | 'apply';

export type RunOptions = {
  command: TierCommand;
  enabled: boolean;
  now: number;
  store: TierStore;
  loadAges: () => Promise<DatabaseObject[]>;
  /**
   * Exact-key rewrite. Dry-run never calls it.
   * Apply calls it once per key, only after that rename succeeds.
   * The CLI passes one pool transaction. Tests inject this and do not open MySQL.
   */
  rewrite?: RewriteObjectKey;
};

const TIER_RULES: readonly { prefix: 'uploads/' | 'outputs/'; tiers: readonly { tier: TierName; days: number }[] }[] = [
  {
    prefix: 'uploads/',
    tiers: [
      { tier: 'archive', days: UPLOAD_ARCHIVE_DAYS },
      { tier: 'infrequent', days: UPLOAD_INFREQUENT_DAYS },
    ],
  },
  {
    prefix: 'outputs/',
    tiers: [
      { tier: 'archive', days: OUTPUT_ARCHIVE_DAYS },
      { tier: 'infrequent', days: OUTPUT_INFREQUENT_DAYS },
    ],
  },
];

/** Exact `1` only. `true`, `yes`, and empty stay off. */
export function readTierTransitionsEnabled(env: { STORAGE_TIER_TRANSITIONS?: string | undefined }): boolean {
  return env.STORAGE_TIER_TRANSITIONS === '1';
}

export function assertLocalStorageDriver(driver: string | undefined): void {
  const normalized = (driver ?? 'local').trim().toLowerCase();
  if (normalized === 's3') {
    throw new Error('storage:tiers 只用于 STORAGE_DRIVER=local；S3/OSS 请改用桶生命周期规则');
  }
}

export function parseTierArgs(argv: string[]): { command: TierCommand; json: boolean } {
  const known = new Set(['--apply', '--json']);
  for (const arg of argv) {
    if (!known.has(arg)) throw new Error(`未知参数: ${arg}`);
  }
  return {
    command: argv.includes('--apply') ? 'apply' : 'dry-run',
    json: argv.includes('--json'),
  };
}

export function isFrozenObjectKey(objectKey: string): boolean {
  return objectKey.startsWith('infrequent/')
    || objectKey.startsWith('archive/')
    || objectKey.startsWith('retention-hold/');
}

export function isHotObjectKey(objectKey: string): boolean {
  if (isFrozenObjectKey(objectKey)) return false;
  if (!objectKey.startsWith('uploads/') && !objectKey.startsWith('outputs/')) return false;
  return safeSegments(objectKey);
}

export function isTierDestinationKey(objectKey: string): boolean {
  if (!safeSegments(objectKey)) return false;
  const tier = objectKey.startsWith('infrequent/')
    ? 'infrequent/'
    : objectKey.startsWith('archive/')
      ? 'archive/'
      : '';
  if (!tier) return false;
  return isHotObjectKey(objectKey.slice(tier.length));
}

/** A hot key may only be renamed onto infrequent/<key> or archive/<key>. */
export function assertTierRelocation(fromKey: string, toKey: string): void {
  if (!isHotObjectKey(fromKey)) throw new Error(`拒绝搬迁已隔离或非热数据对象: ${fromKey}`);
  if (toKey !== `infrequent/${fromKey}` && toKey !== `archive/${fromKey}`) {
    throw new Error(`拒绝搬到分层前缀以外: ${toKey}`);
  }
  if (!isTierDestinationKey(toKey)) throw new Error(`拒绝不安全分层目标: ${toKey}`);
}

/** The inverse rename used when a database rewrite fails: tier key back to the hot key. */
export function isTierRestore(fromKey: string, toKey: string): boolean {
  if (!isHotObjectKey(toKey)) return false;
  return fromKey === `infrequent/${toKey}` || fromKey === `archive/${toKey}`;
}

/**
 * Point every exact copy of `fromKey` at `toKey`.
 * Call this inside one transaction. Affected-row count may be zero for an orphan; that still succeeds.
 * Absolute paths and http(s) URLs are refused before any statement runs.
 */
export async function rewriteTierObjectKey(execute: TierKeyExecute, fromKey: string, toKey: string): Promise<void> {
  assertRewritableObjectKey(fromKey);
  assertRewritableObjectKey(toKey);
  assertTierRelocation(fromKey, toKey);
  for (const sql of TIER_KEY_REWRITE_SQL) {
    await execute(sql, [toKey, fromKey]);
  }
}

export function selectTierMoves(
  listed: readonly ListedObject[],
  ages: readonly DatabaseObject[],
  now: number,
): TierMove[] {
  if (!Number.isFinite(now)) throw new Error('无效的当前时间');
  const births = indexBirths(ages);
  const seen = new Set<string>();
  const moves: TierMove[] = [];
  for (const item of listed) {
    if (!item || typeof item.objectKey !== 'string' || seen.has(item.objectKey)) continue;
    seen.add(item.objectKey);
    if (isFrozenObjectKey(item.objectKey) || !isHotObjectKey(item.objectKey)) continue;
    const birth = birthOf(item, births);
    if (birth == null) continue;
    const ageMs = now - birth;
    if (!Number.isFinite(ageMs) || ageMs < 0) continue;
    const move = classify(item.objectKey, ageMs);
    if (move) moves.push(move);
  }
  moves.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
  return moves;
}

export async function loadTierAges(query: SqlQuery): Promise<DatabaseObject[]> {
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

export async function runStorageTiers(options: RunOptions): Promise<TierReport> {
  if (!Number.isFinite(options.now)) throw new Error('无效的当前时间');
  if (options.command === 'apply' && !options.enabled) {
    throw new Error('STORAGE_TIER_TRANSITIONS 不是 1，拒绝执行 apply，未移动任何对象');
  }

  const ages = await loadDatabaseOrFail(options.loadAges);
  const listed = listOrFail(options.store);
  const planned = selectTierMoves(listed, ages, options.now);
  if (options.command === 'dry-run') {
    return { mode: 'dry-run', enabled: options.enabled, planned, moved: [], failures: [] };
  }
  const applied = await applyMoves(options.store, planned, options.rewrite);
  return { mode: 'apply', enabled: options.enabled, planned, ...applied };
}

type AgeRow = { object_key?: unknown; created_at?: unknown };
type LegacyRow = { result_url?: unknown; poster_url?: unknown; created_at?: unknown };

function classify(objectKey: string, ageMs: number): TierMove | null {
  for (const rule of TIER_RULES) {
    if (!objectKey.startsWith(rule.prefix)) continue;
    for (const tier of rule.tiers) {
      if (ageMs >= tier.days * DAY_MS) {
        const destinationKey = `${tier.tier}/${objectKey}`;
        assertTierRelocation(objectKey, destinationKey);
        return {
          objectKey,
          destinationKey,
          tier: tier.tier,
          ageDays: Math.floor(ageMs / DAY_MS),
        };
      }
    }
    return null;
  }
  return null;
}

function indexBirths(rows: readonly DatabaseObject[]): Map<string, number | null> {
  const births = new Map<string, number | null>();
  for (const row of rows) {
    if (!row || typeof row.objectKey !== 'string' || !isStorageObjectKey(row.objectKey)) continue;
    rememberBirth(births, row.objectKey, row.createdAtMs);
  }
  return births;
}

function rememberBirth(births: Map<string, number | null>, objectKey: string, createdAtMs: number | null): void {
  const finite = typeof createdAtMs === 'number' && Number.isFinite(createdAtMs);
  if (!births.has(objectKey)) {
    births.set(objectKey, finite ? createdAtMs : null);
    return;
  }
  if (!finite) return;
  const known = births.get(objectKey);
  births.set(objectKey, known == null ? createdAtMs : Math.min(known, createdAtMs));
}

/**
 * Database created_at wins when the key is known. A known key with no
 * parseable timestamp is left in place. Objects the database does not
 * mention, including unreferenced orphans, use the listed mtime.
 */
function birthOf(item: ListedObject, births: Map<string, number | null>): number | null {
  if (births.has(item.objectKey)) {
    const created = births.get(item.objectKey);
    return created == null ? null : created;
  }
  return typeof item.modifiedAtMs === 'number' && Number.isFinite(item.modifiedAtMs) ? item.modifiedAtMs : null;
}

async function applyMoves(
  store: TierStore,
  planned: readonly TierMove[],
  rewrite: RewriteObjectKey | undefined,
): Promise<Pick<TierReport, 'moved' | 'failures'>> {
  const moved: string[] = [];
  const failures: TierFailure[] = [];
  for (const item of planned) {
    try {
      assertTierRelocation(item.objectKey, item.destinationKey);
      if (item.destinationKey !== `${item.tier}/${item.objectKey}`) throw new Error('分层目标键不匹配');
      store.move(item.objectKey, item.destinationKey);
    } catch (error) {
      failures.push({ objectKey: item.objectKey, message: errorMessage(error) });
      continue;
    }
    if (!rewrite) {
      moved.push(item.objectKey);
      continue;
    }
    try {
      await rewrite(item.objectKey, item.destinationKey);
      moved.push(item.objectKey);
    } catch (error) {
      const rewriteMessage = errorMessage(error);
      try {
        store.move(item.destinationKey, item.objectKey);
        failures.push({ objectKey: item.objectKey, message: rewriteMessage });
      } catch (rollbackError) {
        failures.push({
          objectKey: item.objectKey,
          message: `两步都失败：数据库回写失败（${rewriteMessage}），文件回滚失败（${errorMessage(rollbackError)}）`,
        });
      }
    }
  }
  return { moved, failures };
}

async function loadDatabaseOrFail(load: () => Promise<DatabaseObject[]>): Promise<DatabaseObject[]> {
  try {
    const rows = await load();
    if (!Array.isArray(rows)) throw new Error('数据库查询结果无效');
    return rows;
  } catch (error) {
    throw new Error(`数据库查询失败，已中止，未移动任何对象: ${errorMessage(error)}`);
  }
}

function listOrFail(store: TierStore): ListedObject[] {
  try {
    const listed = store.list();
    if (!Array.isArray(listed)) throw new Error('对象列举结果无效');
    return listed;
  } catch (error) {
    throw new Error(`对象列举失败，已中止，未移动任何对象: ${errorMessage(error)}`);
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
  const createdAtMs = readCreatedAt(row);
  if (objectKey == null || !isStorageObjectKey(objectKey)) return null;
  return { objectKey, createdAtMs };
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

function isStorageObjectKey(value: string | null | undefined): value is string {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return true;
}

function assertRewritableObjectKey(objectKey: string): void {
  if (!isStorageObjectKey(objectKey)) {
    throw new Error(`拒绝把绝对路径或 URL 当作对象键回写: ${objectKey}`);
  }
}

function safeSegments(key: string): boolean {
  if (key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** MySQL `dateStrings` values are UTC wall times (`timezone: 'Z'`). */
export function createdAtMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const iso = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
