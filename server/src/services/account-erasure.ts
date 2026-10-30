/**
 * Account close and the 30-day physical purge.
 *
 * Closing an account only stamps users.deleted_at and revokes refresh tokens.
 * The user row stays, because credit_transactions and orders are ON DELETE
 * CASCADE from users. The purge job later deletes that user's tasks, task
 * outputs, asset rows and sessions, deletes only the object keys those rows
 * cite, then replaces the email and clears the password and display name.
 * Ledger tables and the user row are not deleted.
 *
 * Object deletes run only after the database transaction commits. A failed
 * statement rolls back and leaves storage untouched.
 */

export const DEFAULT_ERASURE_DAYS = 30;
export const DAY_MS = 86_400_000;

/** Stored in place of a real password hash. Not a bcrypt hash, so it cannot match. */
export const CLEARED_PASSWORD_HASH = '';

export const SELECT_USER_BY_ID_SQL =
  'SELECT id, email, password_hash, display_name, credits, created_at, deleted_at FROM users WHERE id = ? LIMIT 1';

export const SELECT_USER_BY_ID_FOR_UPDATE_SQL =
  'SELECT id, email, password_hash, display_name, credits, created_at, deleted_at FROM users WHERE id = ? LIMIT 1 FOR UPDATE';

export const SELECT_USER_BY_EMAIL_SQL =
  'SELECT id, email, password_hash, display_name, credits, created_at, deleted_at FROM users WHERE email = ? LIMIT 1';

/** A second close must not move deleted_at. The IS NULL guard is what keeps the original instant. */
export const MARK_DELETED_SQL =
  'UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL';

export const REVOKE_SESSIONS_SQL =
  'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL';

/** Age is inclusive: a closure exactly 30 days old is due. Younger rows are not. */
export const SELECT_DUE_USERS_SQL =
  'SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY id';

export const LOCK_DUE_USER_SQL =
  'SELECT id, deleted_at FROM users WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 1 FOR UPDATE';

export const SELECT_TASKS_SQL =
  'SELECT id, result_url, poster_url FROM generation_tasks WHERE user_id = ?';

export const SELECT_OUTPUTS_SQL =
  'SELECT o.object_key AS object_key FROM task_outputs o INNER JOIN generation_tasks t ON t.id = o.task_id WHERE t.user_id = ?';

export const SELECT_ASSETS_SQL =
  'SELECT url AS object_key FROM assets WHERE user_id = ?';

export const SELECT_SESSIONS_SQL =
  'SELECT id FROM refresh_tokens WHERE user_id = ?';

export const DELETE_TASK_REFS_SQL =
  'DELETE r FROM generation_refs r INNER JOIN generation_tasks t ON t.id = r.task_id WHERE t.user_id = ?';

export const DELETE_ASSET_REFS_SQL =
  'DELETE r FROM generation_refs r INNER JOIN assets a ON a.id = r.asset_id WHERE a.user_id = ?';

export const DELETE_OUTPUTS_SQL =
  'DELETE o FROM task_outputs o INNER JOIN generation_tasks t ON t.id = o.task_id WHERE t.user_id = ?';

export const DELETE_TASKS_SQL = 'DELETE FROM generation_tasks WHERE user_id = ?';

export const DELETE_ASSETS_SQL = 'DELETE FROM assets WHERE user_id = ?';

export const DELETE_SESSIONS_SQL = 'DELETE FROM refresh_tokens WHERE user_id = ?';

/** Does not touch id, credits, or deleted_at. */
export const ANONYMIZE_USER_SQL =
  'UPDATE users SET email = ?, password_hash = ?, display_name = NULL WHERE id = ? AND deleted_at IS NOT NULL';

export class BadPasswordError extends Error {
  readonly userId: string | null;
  constructor(userId: string | null = null) {
    super('密码错误');
    this.name = 'BadPasswordError';
    this.userId = userId;
  }
}

export class UnknownUserError extends Error {
  constructor() {
    super('邮箱或密码错误');
    this.name = 'UnknownUserError';
  }
}

export class AccountMissingError extends Error {
  constructor() {
    super('用户不存在');
    this.name = 'AccountMissingError';
  }
}

export class AccountClosedError extends Error {
  readonly userId: string | null;
  constructor(userId: string | null = null) {
    super('账户已注销');
    this.name = 'AccountClosedError';
    this.userId = userId;
  }
}

export type ErasureConnection = {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

export type ObjectRemover = {
  remove(objectKey: string): Promise<void>;
};

export type AccountUser = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  credits: number;
  created_at: string;
  deleted_at: string | null;
};

export type PurgeReport = {
  mode: 'dry-run' | 'apply';
  retentionDays: number;
  cutoff: string;
  userIds: string[];
  tasks: number;
  outputs: number;
  assets: number;
  sessions: number;
  objectKeys: string[];
  anonymized: number;
};

type PasswordCheck = (password: string, passwordHash: string) => Promise<boolean>;

type MysqlLike = {
  query(sql: string, params?: any[]): Promise<unknown>;
  beginTransaction(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
};

export function asErasureConnection(conn: MysqlLike): ErasureConnection {
  return {
    query: (sql, params) => conn.query(sql, params as any[] | undefined),
    beginTransaction: async () => {
      await conn.beginTransaction();
    },
    commit: async () => {
      await conn.commit();
    },
    rollback: async () => {
      await conn.rollback();
    },
  };
}

/** Wraps the pool helper that already unwraps rows into `[rows]`. */
export function erasureConnectionFromRows(
  run: (sql: string, params: readonly unknown[]) => Promise<readonly unknown[]>,
): ErasureConnection {
  return {
    async query(sql, params) {
      return [await run(sql, params ?? [])];
    },
    async beginTransaction() {
      throw new Error('只读账户连接不能开启事务');
    },
    async commit() {},
    async rollback() {},
  };
}

export function accountIsClosed(user: { deleted_at?: unknown } | null | undefined): boolean {
  if (!user) return false;
  const value = user.deleted_at;
  return value != null && value !== '';
}

/** Not an email address, so the login schema cannot accept it. Unique per user id. */
export function erasedEmail(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) {
    throw new Error('无法为该用户生成注销占位邮箱');
  }
  return `erased:${userId}`;
}

/**
 * Object keys stored on task and asset rows. Signed URLs and absolute paths
 * are not keys in our bucket, so they are not passed to the storage driver.
 */
export function referencedObjectKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  if (trimmed.includes('..') || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}

export function parsePurgeArgs(argv: string[]): { apply: boolean; retentionDays: number } {
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
    retentionDays: integerFlag(argv, '--retention-days', DEFAULT_ERASURE_DAYS),
  };
}

export function erasureCutoff(now: Date, retentionDays: number): Date {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    throw new Error('--retention-days 必须是非负整数');
  }
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/** UTC wall time. Matches the pool timezone `'Z'` datetime binding. */
export function formatMysqlDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('无效的截止时间');
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Verifies the current password, stamps deleted_at once, and revokes every
 * refresh token. A wrong password throws before any write. A second call keeps
 * the original deleted_at.
 */
export async function closeAccount(
  conn: ErasureConnection,
  input: { userId: string; password: string; now?: Date; verifyPassword: PasswordCheck },
): Promise<{ deletedAt: string; alreadyClosed: boolean }> {
  if (typeof input.password !== 'string' || input.password.length === 0) {
    throw new BadPasswordError(input.userId || null);
  }

  const existing = await selectUser(conn, SELECT_USER_BY_ID_SQL, [input.userId]);
  if (!existing) throw new AccountMissingError();
  if (!(await passwordMatches(input.verifyPassword, input.password, existing.password_hash))) {
    throw new BadPasswordError(existing.id);
  }

  const now = input.now ?? new Date();
  const stampedAt = formatMysqlDateTime(now);
  await conn.beginTransaction();
  try {
    const locked = await selectUser(conn, SELECT_USER_BY_ID_FOR_UPDATE_SQL, [input.userId]);
    if (!locked) throw new AccountMissingError();
    const alreadyClosed = accountIsClosed(locked);
    const deletedAt = alreadyClosed ? locked.deleted_at! : stampedAt;
    if (!alreadyClosed) {
      await conn.query(MARK_DELETED_SQL, [deletedAt, locked.id]);
    }
    await conn.query(REVOKE_SESSIONS_SQL, [stampedAt, locked.id]);
    await conn.commit();
    return { deletedAt, alreadyClosed };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  }
}

/**
 * Password login. A closed account is rejected even when the password matches,
 * and no session is created by this function.
 */
export async function loginWithPassword(
  conn: ErasureConnection,
  input: { email: string; password: string; verifyPassword: PasswordCheck },
): Promise<AccountUser> {
  const user = await selectUser(conn, SELECT_USER_BY_EMAIL_SQL, [input.email]);
  if (!user) throw new UnknownUserError();
  if (accountIsClosed(user)) throw new AccountClosedError(user.id);
  if (!(await passwordMatches(input.verifyPassword, input.password, user.password_hash))) {
    throw new BadPasswordError(user.id);
  }
  return user;
}

/** Refresh-session gate. Closed and missing users cannot mint a new access token. */
export async function requireOpenUser(conn: ErasureConnection, userId: string): Promise<AccountUser> {
  const user = await selectUser(conn, SELECT_USER_BY_ID_SQL, [userId]);
  if (!user) throw new AccountMissingError();
  if (accountIsClosed(user)) throw new AccountClosedError(user.id);
  return user;
}

/**
 * Purge tasks, outputs, assets and sessions for accounts closed at least
 * `retentionDays` ago (default 30). Without `apply`, this only reports.
 * Storage deletes happen after commit; a database error deletes nothing.
 */
export async function purgeDeletedAccounts(
  conn: ErasureConnection,
  options: { apply: boolean; retentionDays?: number; now?: Date },
  objects: ObjectRemover,
): Promise<PurgeReport> {
  const retentionDays = options.retentionDays ?? DEFAULT_ERASURE_DAYS;
  const now = options.now ?? new Date();
  const cutoff = formatMysqlDateTime(erasureCutoff(now, retentionDays));
  const dueIds = await selectDueUserIds(conn, cutoff);
  if (!options.apply || dueIds.length === 0) {
    const preview = dueIds.length === 0 ? emptyCleanup() : await inspectUsers(conn, dueIds);
    return report(options.apply ? 'apply' : 'dry-run', retentionDays, cutoff, dueIds, preview, 0);
  }

  await conn.beginTransaction();
  let cleanup = emptyCleanup();
  const purgedIds: string[] = [];
  try {
    for (const userId of dueIds) {
      const locked = readRows<{ id: unknown }>(await conn.query(LOCK_DUE_USER_SQL, [userId, cutoff]));
      if (locked.length === 0) continue;
      const inspected = await inspectUser(conn, userId);
      await conn.query(DELETE_TASK_REFS_SQL, [userId]);
      await conn.query(DELETE_ASSET_REFS_SQL, [userId]);
      await conn.query(DELETE_OUTPUTS_SQL, [userId]);
      await conn.query(DELETE_TASKS_SQL, [userId]);
      await conn.query(DELETE_ASSETS_SQL, [userId]);
      await conn.query(DELETE_SESSIONS_SQL, [userId]);
      const anonymized = affectedRows(
        await conn.query(ANONYMIZE_USER_SQL, [erasedEmail(userId), CLEARED_PASSWORD_HASH, userId]),
      );
      if (anonymized !== 1) throw new Error(`未能匿名化用户 ${userId}`);
      cleanup = mergeCleanup(cleanup, inspected);
      purgedIds.push(userId);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  }

  for (const key of cleanup.objectKeys) {
    await objects.remove(key);
  }
  return report('apply', retentionDays, cutoff, purgedIds, cleanup, purgedIds.length);
}

type Cleanup = {
  tasks: number;
  outputs: number;
  assets: number;
  sessions: number;
  objectKeys: string[];
};

function emptyCleanup(): Cleanup {
  return { tasks: 0, outputs: 0, assets: 0, sessions: 0, objectKeys: [] };
}

function report(
  mode: PurgeReport['mode'],
  retentionDays: number,
  cutoff: string,
  userIds: string[],
  cleanup: Cleanup,
  anonymized: number,
): PurgeReport {
  return {
    mode,
    retentionDays,
    cutoff,
    userIds,
    tasks: cleanup.tasks,
    outputs: cleanup.outputs,
    assets: cleanup.assets,
    sessions: cleanup.sessions,
    objectKeys: cleanup.objectKeys,
    anonymized,
  };
}

async function inspectUsers(conn: ErasureConnection, userIds: string[]): Promise<Cleanup> {
  let cleanup = emptyCleanup();
  for (const userId of userIds) {
    cleanup = mergeCleanup(cleanup, await inspectUser(conn, userId));
  }
  return cleanup;
}

async function inspectUser(conn: ErasureConnection, userId: string): Promise<Cleanup> {
  const tasks = readRows<{ result_url?: unknown; poster_url?: unknown }>(
    await conn.query(SELECT_TASKS_SQL, [userId]),
  );
  const outputs = readRows<{ object_key?: unknown }>(await conn.query(SELECT_OUTPUTS_SQL, [userId]));
  const assets = readRows<{ object_key?: unknown }>(await conn.query(SELECT_ASSETS_SQL, [userId]));
  const sessions = readRows(await conn.query(SELECT_SESSIONS_SQL, [userId]));
  const keys = new Set<string>();
  for (const task of tasks) {
    pushKey(keys, task.result_url);
    pushKey(keys, task.poster_url);
  }
  for (const output of outputs) pushKey(keys, output.object_key);
  for (const asset of assets) pushKey(keys, asset.object_key);
  return {
    tasks: tasks.length,
    outputs: outputs.length,
    assets: assets.length,
    sessions: sessions.length,
    objectKeys: [...keys].sort(),
  };
}

function mergeCleanup(left: Cleanup, right: Cleanup): Cleanup {
  return {
    tasks: left.tasks + right.tasks,
    outputs: left.outputs + right.outputs,
    assets: left.assets + right.assets,
    sessions: left.sessions + right.sessions,
    objectKeys: [...new Set([...left.objectKeys, ...right.objectKeys])].sort(),
  };
}

function pushKey(keys: Set<string>, value: unknown) {
  const key = referencedObjectKey(value);
  if (key) keys.add(key);
}

async function selectDueUserIds(conn: ErasureConnection, cutoff: string): Promise<string[]> {
  const rows = readRows<{ id?: unknown }>(await conn.query(SELECT_DUE_USERS_SQL, [cutoff]));
  return rows.map((row) => String(row.id ?? '')).filter((id) => id.length > 0);
}

async function selectUser(
  conn: ErasureConnection,
  sql: string,
  params: readonly unknown[],
): Promise<AccountUser | null> {
  const rows = readRows<Record<string, unknown>>(await conn.query(sql, params));
  const row = rows[0];
  if (!row) return null;
  return mapUser(row);
}

function mapUser(row: Record<string, unknown>): AccountUser {
  const id = asText(row.id);
  const email = asText(row.email);
  if (!id || !email) throw new Error('用户行缺少 id 或 email');
  const deletedAt = row.deleted_at == null || row.deleted_at === '' ? null : asText(row.deleted_at);
  return {
    id,
    email,
    password_hash: row.password_hash == null ? '' : String(row.password_hash),
    display_name: row.display_name == null ? null : String(row.display_name),
    credits: Number(row.credits ?? 0),
    created_at: row.created_at == null ? '' : asText(row.created_at),
    deleted_at: deletedAt,
  };
}

async function passwordMatches(verify: PasswordCheck, password: string, hash: string): Promise<boolean> {
  try {
    return await verify(password, hash);
  } catch {
    return false;
  }
}

function readRows<T>(result: unknown): T[] {
  const packet = Array.isArray(result) ? result[0] : result;
  if (!Array.isArray(packet)) return [];
  return packet as T[];
}

function affectedRows(result: unknown): number {
  const packet = Array.isArray(result) ? result[0] : result;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || !('affectedRows' in packet)) return 0;
  const count = Number((packet as { affectedRows: unknown }).affectedRows);
  return Number.isFinite(count) ? count : 0;
}

function asText(value: unknown): string {
  if (value instanceof Date) return formatMysqlDateTime(value);
  return String(value ?? '');
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
