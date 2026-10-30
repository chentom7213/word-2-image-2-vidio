/**
 * Free-plan output hold. This does not recycle unreferenced orphans; that
 * stays in storage-lifecycle, which still deletes only objects the database
 * no longer cites.
 *
 * Eligible objects are moved under `retention-hold/` and can be moved back
 * during the recovery window. A separate purge command deletes them only
 * after that window. Paid plan ids are never eligible and are never purged.
 */

export const DAY_MS = 86_400_000;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RECOVERY_DAYS = 7;
export const QUARANTINE_PREFIX = 'retention-hold/';

/** Same three reference sources as storage-lifecycle. Read-only. */
export const OUTPUT_REFERENCES_SQL =
  'SELECT o.object_key AS object_key, o.created_at AS created_at, t.user_id AS user_id, ' +
  'u.plan_id AS plan_id, u.plan_expires_at AS plan_expires_at ' +
  'FROM task_outputs o ' +
  'INNER JOIN generation_tasks t ON t.id = o.task_id ' +
  'INNER JOIN users u ON u.id = t.user_id';

export const ASSET_REFERENCES_SQL =
  'SELECT a.url AS object_key, a.created_at AS created_at, a.user_id AS user_id, ' +
  'u.plan_id AS plan_id, u.plan_expires_at AS plan_expires_at ' +
  'FROM assets a ' +
  'INNER JOIN users u ON u.id = a.user_id';

export const LEGACY_REFERENCES_SQL =
  'SELECT g.result_url AS result_url, g.poster_url AS poster_url, g.created_at AS created_at, ' +
  'g.user_id AS user_id, u.plan_id AS plan_id, u.plan_expires_at AS plan_expires_at ' +
  'FROM generation_tasks g ' +
  'INNER JOIN users u ON u.id = g.user_id ' +
  'WHERE g.result_url IS NOT NULL OR g.poster_url IS NOT NULL';

export type SqlQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export type ReferenceRow = {
  objectKey: string;
  createdAtMs: number | null;
  planId: string | null;
  /** Loaded for audit. Expiry does not turn a non-free plan id into a free one. */
  planExpiresAt: string | null;
  userId: string | null;
};

export type QuarantineCandidate = {
  objectKey: string;
  quarantineKey: string;
  createdAtMs: number;
  userId: string | null;
};

export type QuarantineSelection = {
  candidates: QuarantineCandidate[];
  excludedPaid: string[];
  excludedYoung: string[];
  excludedOther: string[];
};

export type QuarantineRecord = {
  originalKey: string;
  quarantineKey: string;
  quarantinedAtMs: number;
  userId: string | null;
};

export interface RetentionStore {
  has(objectKey: string): boolean;
  listQuarantine(): QuarantineRecord[];
  quarantine(record: QuarantineRecord): void;
  restore(record: QuarantineRecord): void;
  purge(record: QuarantineRecord): void;
}

export type RetentionCommand = 'dry-run' | 'apply' | 'restore' | 'purge';

export type RetentionSkip = { objectKey: string; reason: string };
export type RetentionFailure = { objectKey: string; message: string };
export type RetentionNotice = { userId: string | null; objectKeys: string[]; message: string };

export type RetentionReport = {
  mode: RetentionCommand;
  enabled: boolean;
  retentionDays: number;
  recoveryDays: number;
  holdPrefix: string;
  candidates: QuarantineCandidate[];
  excludedPaid: string[];
  excludedYoung: string[];
  excludedOther: string[];
  notices: RetentionNotice[];
  moved: string[];
  restored: string[];
  purged: string[];
  skipped: RetentionSkip[];
  failures: RetentionFailure[];
};

export type RunOptions = {
  command: RetentionCommand;
  enabled: boolean;
  now: number;
  retentionDays?: number;
  recoveryDays?: number;
  restoreKeys?: string[];
  store: RetentionStore;
  loadReferences: () => Promise<ReferenceRow[]>;
};

type OutputRefRow = {
  object_key?: unknown;
  created_at?: unknown;
  user_id?: unknown;
  plan_id?: unknown;
  plan_expires_at?: unknown;
};

type LegacyRefRow = {
  result_url?: unknown;
  poster_url?: unknown;
  created_at?: unknown;
  user_id?: unknown;
  plan_id?: unknown;
  plan_expires_at?: unknown;
};

/**
 * Only an explicit free plan id is eligible. `pro` / `enterprise` stay
 * ineligible after `plan_expires_at`, so a paid output is never selected.
 */
export function isFreePlanId(planId: string | null | undefined): boolean {
  if (planId == null) return true;
  const id = planId.trim();
  return id === '' || id === 'free';
}

/** Mirrors storage-lifecycle's object-key filter: relative keys only, never URLs. */
export function isStorageObjectKey(value: string | null | undefined): value is string {
  return Boolean(value && !value.startsWith('/') && !value.startsWith('\\') && !/^https?:\/\//i.test(value));
}

export function isOutputObjectKey(value: string | null | undefined): value is string {
  if (!isStorageObjectKey(value) || !value.startsWith('outputs/')) return false;
  return safeSegments(value);
}

export function quarantineKeyFor(objectKey: string): string {
  if (!isOutputObjectKey(objectKey)) throw new Error(`拒绝隔离非 outputs 对象: ${objectKey}`);
  return `${QUARANTINE_PREFIX}${objectKey}`;
}

export function assertHeldObjectKey(quarantineKey: string): void {
  if (!quarantineKey.startsWith(`${QUARANTINE_PREFIX}outputs/`) || !safeSegments(quarantineKey)) {
    throw new Error(`拒绝删除隔离区以外的对象: ${quarantineKey}`);
  }
}

export function assertQuarantineRecord(record: QuarantineRecord): void {
  if (!isOutputObjectKey(record.originalKey)) throw new Error(`拒绝隔离非 outputs 对象: ${record.originalKey}`);
  if (record.quarantineKey !== quarantineKeyFor(record.originalKey)) {
    throw new Error(`隔离键不匹配: ${record.quarantineKey}`);
  }
  assertHeldObjectKey(record.quarantineKey);
  if (!Number.isFinite(record.quarantinedAtMs)) throw new Error('隔离时间无效');
}

export function parseQuarantineManifest(raw: string): QuarantineRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('隔离清单损坏，已中止，未移动或删除任何对象');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error('隔离清单损坏，已中止，未移动或删除任何对象');
  }
  return (parsed as { records: unknown[] }).records.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('隔离清单损坏，已中止，未移动或删除任何对象');
    const row = item as Record<string, unknown>;
    const record: QuarantineRecord = {
      originalKey: typeof row.originalKey === 'string' ? row.originalKey : '',
      quarantineKey: typeof row.quarantineKey === 'string' ? row.quarantineKey : '',
      quarantinedAtMs: typeof row.quarantinedAtMs === 'number' ? row.quarantinedAtMs : Number.NaN,
      userId: typeof row.userId === 'string' ? row.userId : null,
    };
    assertQuarantineRecord(record);
    return record;
  });
}

/** Exact `1` only. `true`, `yes`, and empty stay off. */
export function readPlanRetentionEnabled(env: { STORAGE_PLAN_RETENTION?: string | undefined }): boolean {
  return env.STORAGE_PLAN_RETENTION === '1';
}

export function userNotice(retentionDays: number, recoveryDays: number): string {
  return (
    `用户通知：免费套餐产物已超过 ${retentionDays} 天，将被隔离保留 ${recoveryDays} 天。` +
    '窗口内可恢复原路径；只有窗口过后的显式 purge 才会删除。付费套餐产物不会被隔离或删除。'
  );
}

export function recoveryElapsed(quarantinedAtMs: number, now: number, recoveryDays: number): boolean {
  return now - quarantinedAtMs >= recoveryDays * DAY_MS;
}

export function selectQuarantineCandidates(
  rows: readonly ReferenceRow[],
  now: number,
  retentionDays = DEFAULT_RETENTION_DAYS,
): QuarantineSelection {
  assertDayCount('retentionDays', retentionDays);
  if (!Number.isFinite(now)) throw new Error('无效的当前时间');
  const cutoff = now - retentionDays * DAY_MS;
  const grouped = new Map<string, KeyState>();

  for (const row of rows) {
    if (!isStorageObjectKey(row.objectKey)) continue;
    const state = grouped.get(row.objectKey) ?? {
      objectKey: row.objectKey,
      userId: row.userId,
      paid: false,
      free: false,
      output: isOutputObjectKey(row.objectKey),
      newestFreeCreatedAtMs: null,
      freeAgeUnknown: false,
    };
    if (isFreePlanId(row.planId)) {
      state.free = true;
      if (row.userId) state.userId = row.userId;
      if (row.createdAtMs == null || !Number.isFinite(row.createdAtMs)) state.freeAgeUnknown = true;
      else state.newestFreeCreatedAtMs = state.newestFreeCreatedAtMs == null
        ? row.createdAtMs
        : Math.max(state.newestFreeCreatedAtMs, row.createdAtMs);
    } else {
      state.paid = true;
    }
    grouped.set(row.objectKey, state);
  }

  const candidates: QuarantineCandidate[] = [];
  const excludedPaid: string[] = [];
  const excludedYoung: string[] = [];
  const excludedOther: string[] = [];
  for (const state of [...grouped.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey))) {
    if (state.paid || !state.free) {
      if (state.paid) excludedPaid.push(state.objectKey);
      continue;
    }
    if (!state.output) {
      excludedOther.push(state.objectKey);
      continue;
    }
    if (state.freeAgeUnknown || state.newestFreeCreatedAtMs == null || state.newestFreeCreatedAtMs > cutoff) {
      excludedYoung.push(state.objectKey);
      continue;
    }
    candidates.push({
      objectKey: state.objectKey,
      quarantineKey: quarantineKeyFor(state.objectKey),
      createdAtMs: state.newestFreeCreatedAtMs,
      userId: state.userId,
    });
  }
  return { candidates, excludedPaid, excludedYoung, excludedOther };
}

export function parseRetentionArgs(argv: string[]): {
  command: RetentionCommand;
  json: boolean;
  retentionDays: number;
  recoveryDays: number;
  keys: string[];
} {
  const known = new Set(['--apply', '--restore', '--purge', '--json', '--retention-days', '--recovery-days', '--key']);
  const keys: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!known.has(arg)) throw new Error(`未知参数: ${arg}`);
    if (arg === '--retention-days' || arg === '--recovery-days' || arg === '--key') i += 1;
  }
  const commands = ['--apply', '--restore', '--purge'].filter((flag) => argv.includes(flag));
  if (commands.length > 1) throw new Error('只能指定 --apply、--restore、--purge 中的一个');
  const command: RetentionCommand = argv.includes('--apply')
    ? 'apply'
    : argv.includes('--restore')
      ? 'restore'
      : argv.includes('--purge')
        ? 'purge'
        : 'dry-run';
  return {
    command,
    json: argv.includes('--json'),
    retentionDays: integerFlag(argv, '--retention-days', DEFAULT_RETENTION_DAYS),
    recoveryDays: integerFlag(argv, '--recovery-days', DEFAULT_RECOVERY_DAYS),
    keys: collectKeys(argv, keys),
  };
}

export async function loadReferencedOutputs(query: SqlQuery): Promise<ReferenceRow[]> {
  const outputs = await fetchRows<OutputRefRow>(query, OUTPUT_REFERENCES_SQL);
  const assets = await fetchRows<OutputRefRow>(query, ASSET_REFERENCES_SQL);
  const legacy = await fetchRows<LegacyRefRow>(query, LEGACY_REFERENCES_SQL);
  return [
    ...outputs.map((row) => mapReference(row, readKey(row, 'object_key'))),
    ...assets.map((row) => mapReference(row, readKey(row, 'object_key'))),
    ...legacy.flatMap((row) => [readKey(row, 'result_url'), readKey(row, 'poster_url')]
      .filter((key): key is string => key != null)
      .map((key) => mapReference(row, key))),
  ].filter((row) => isStorageObjectKey(row.objectKey));
}

export async function runPlanRetention(options: RunOptions): Promise<RetentionReport> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const recoveryDays = options.recoveryDays ?? DEFAULT_RECOVERY_DAYS;
  assertDayCount('retentionDays', retentionDays);
  assertDayCount('recoveryDays', recoveryDays);
  if (!Number.isFinite(options.now)) throw new Error('无效的当前时间');
  if (options.command !== 'dry-run' && !options.enabled) {
    throw new Error(`STORAGE_PLAN_RETENTION 不是 1，拒绝执行 ${options.command}，未移动或删除任何对象`);
  }

  const references = await loadOrFail(options.loadReferences);
  const selection = selectQuarantineCandidates(references, options.now, retentionDays);
  const notices = buildNotices(selection.candidates, retentionDays, recoveryDays);
  const base = {
    enabled: options.enabled,
    retentionDays,
    recoveryDays,
    holdPrefix: QUARANTINE_PREFIX,
    candidates: selection.candidates,
    excludedPaid: selection.excludedPaid,
    excludedYoung: selection.excludedYoung,
    excludedOther: selection.excludedOther,
    notices,
  };

  if (options.command === 'dry-run') {
    return { mode: 'dry-run', ...base, moved: [], restored: [], purged: [], skipped: [], failures: [] };
  }
  if (options.command === 'apply') return { mode: 'apply', ...base, ...applyHold(options, selection.candidates) };
  const held = readHold(options.store);
  if (options.command === 'restore') {
    return { mode: 'restore', ...base, ...restoreHold(options, held, recoveryDays) };
  }
  return { mode: 'purge', ...base, ...purgeHold(options, references, held, recoveryDays) };
}

type KeyState = {
  objectKey: string;
  userId: string | null;
  paid: boolean;
  free: boolean;
  output: boolean;
  newestFreeCreatedAtMs: number | null;
  freeAgeUnknown: boolean;
};

function applyHold(options: RunOptions, candidates: QuarantineCandidate[]): Pick<RetentionReport, 'moved' | 'restored' | 'purged' | 'skipped' | 'failures'> {
  readHold(options.store);
  const moved: string[] = [];
  const skipped: RetentionSkip[] = [];
  const failures: RetentionFailure[] = [];
  for (const candidate of candidates) {
    const record: QuarantineRecord = {
      originalKey: candidate.objectKey,
      quarantineKey: candidate.quarantineKey,
      quarantinedAtMs: options.now,
      userId: candidate.userId,
    };
    try {
      assertQuarantineRecord(record);
      if (!options.store.has(candidate.objectKey)) {
        skipped.push({ objectKey: candidate.objectKey, reason: 'missing' });
        continue;
      }
      if (options.store.has(record.quarantineKey)) {
        skipped.push({ objectKey: candidate.objectKey, reason: 'already-quarantined' });
        continue;
      }
      options.store.quarantine(record);
      moved.push(candidate.objectKey);
    } catch (error) {
      failures.push({ objectKey: candidate.objectKey, message: errorMessage(error) });
    }
  }
  return { moved, restored: [], purged: [], skipped, failures };
}

function restoreHold(
  options: RunOptions,
  held: QuarantineRecord[],
  recoveryDays: number,
): Pick<RetentionReport, 'moved' | 'restored' | 'purged' | 'skipped' | 'failures'> {
  const wanted = new Set(options.restoreKeys ?? []);
  const restored: string[] = [];
  const skipped: RetentionSkip[] = [];
  const failures: RetentionFailure[] = [];
  for (const record of held) {
    if (wanted.size > 0 && !wanted.has(record.originalKey) && !wanted.has(record.quarantineKey)) continue;
    if (recoveryElapsed(record.quarantinedAtMs, options.now, recoveryDays)) {
      skipped.push({ objectKey: record.originalKey, reason: 'past-recovery-window' });
      continue;
    }
    try {
      assertQuarantineRecord(record);
      options.store.restore(record);
      restored.push(record.originalKey);
    } catch (error) {
      failures.push({ objectKey: record.originalKey, message: errorMessage(error) });
    }
  }
  return { moved: [], restored, purged: [], skipped, failures };
}

function purgeHold(
  options: RunOptions,
  references: ReferenceRow[],
  held: QuarantineRecord[],
  recoveryDays: number,
): Pick<RetentionReport, 'moved' | 'restored' | 'purged' | 'skipped' | 'failures'> {
  const paid = paidObjectKeys(references);
  const purged: string[] = [];
  const skipped: RetentionSkip[] = [];
  const failures: RetentionFailure[] = [];
  for (const record of held) {
    try {
      assertQuarantineRecord(record);
      assertHeldObjectKey(record.quarantineKey);
    } catch (error) {
      failures.push({ objectKey: record.originalKey || record.quarantineKey, message: errorMessage(error) });
      continue;
    }
    if (paid.has(record.originalKey)) {
      skipped.push({ objectKey: record.originalKey, reason: 'paid-plan' });
      continue;
    }
    if (!recoveryElapsed(record.quarantinedAtMs, options.now, recoveryDays)) {
      skipped.push({ objectKey: record.originalKey, reason: 'inside-recovery-window' });
      continue;
    }
    try {
      options.store.purge(record);
      purged.push(record.originalKey);
    } catch (error) {
      failures.push({ objectKey: record.originalKey, message: errorMessage(error) });
    }
  }
  return { moved: [], restored: [], purged, skipped, failures };
}

function paidObjectKeys(rows: readonly ReferenceRow[]): Set<string> {
  const paid = new Set<string>();
  for (const row of rows) {
    if (!isStorageObjectKey(row.objectKey)) continue;
    if (!isFreePlanId(row.planId)) paid.add(row.objectKey);
  }
  return paid;
}

function buildNotices(candidates: QuarantineCandidate[], retentionDays: number, recoveryDays: number): RetentionNotice[] {
  const message = userNotice(retentionDays, recoveryDays);
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    const id = candidate.userId ?? '';
    const keys = groups.get(id) ?? [];
    keys.push(candidate.objectKey);
    groups.set(id, keys);
  }
  return [...groups.entries()].map(([userId, objectKeys]) => ({
    userId: userId || null,
    objectKeys,
    message,
  }));
}

async function loadOrFail(load: () => Promise<ReferenceRow[]>): Promise<ReferenceRow[]> {
  try {
    return await load();
  } catch (error) {
    throw new Error(`引用查询失败，已中止，未移动或删除任何对象: ${errorMessage(error)}`);
  }
}

function readHold(store: RetentionStore): QuarantineRecord[] {
  try {
    return store.listQuarantine().map((record) => ({ ...record }));
  } catch (error) {
    throw new Error(`隔离清单不可读，已中止，未移动或删除任何对象: ${errorMessage(error)}`);
  }
}

function isReferenceSql(sql: string): boolean {
  return sql === OUTPUT_REFERENCES_SQL || sql === ASSET_REFERENCES_SQL || sql === LEGACY_REFERENCES_SQL;
}

async function fetchRows<T>(query: SqlQuery, sql: string): Promise<T[]> {
  if (!isReferenceSql(sql)) throw new Error('拒绝执行未知引用查询');
  const rows = await query<T>(sql);
  if (!Array.isArray(rows)) throw new Error('引用查询结果无效，已中止');
  return rows;
}

function mapReference(row: object, objectKey: string | null): ReferenceRow {
  if (!Object.prototype.hasOwnProperty.call(row, 'plan_id')) throw new Error('引用查询缺少 plan_id，已中止');
  if (!Object.prototype.hasOwnProperty.call(row, 'created_at')) throw new Error('引用查询缺少 created_at，已中止');
  return {
    objectKey: objectKey ?? '',
    createdAtMs: createdAtMs(readOwn(row, 'created_at')),
    planId: readPlanId(readOwn(row, 'plan_id')),
    planExpiresAt: readOptionalString(readOwn(row, 'plan_expires_at')),
    userId: readOptionalString(readOwn(row, 'user_id')),
  };
}

function readKey(row: object, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`引用查询缺少 ${field}，已中止`);
  const value = readOwn(row, field);
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`引用查询的 ${field} 无效，已中止`);
  return value;
}

function readPlanId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('引用查询的 plan_id 无效，已中止');
  return value;
}

function readOptionalString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'string' ? value : null;
}

function readOwn(row: object, field: string): unknown {
  return (row as Record<string, unknown>)[field];
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

function safeSegments(key: string): boolean {
  if (key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function assertDayCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
}

function integerFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const raw = argv[index + 1];
  if (raw === undefined || raw.startsWith('--')) throw new Error(`${flag} 缺少数值`);
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} 必须是正整数`);
  return value;
}

function collectKeys(argv: string[], keys: string[]): string[] {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--key') continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--key 缺少数值');
    keys.push(value);
  }
  return keys;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
