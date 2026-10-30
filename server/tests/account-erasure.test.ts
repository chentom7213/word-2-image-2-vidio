import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANONYMIZE_USER_SQL,
  AccountClosedError,
  AccountMissingError,
  BadPasswordError,
  CLEARED_PASSWORD_HASH,
  DAY_MS,
  DELETE_ASSETS_SQL,
  DELETE_ASSET_REFS_SQL,
  DELETE_OUTPUTS_SQL,
  DELETE_SESSIONS_SQL,
  DELETE_TASKS_SQL,
  DELETE_TASK_REFS_SQL,
  LOCK_DUE_USER_SQL,
  MARK_DELETED_SQL,
  REVOKE_SESSIONS_SQL,
  SELECT_ASSETS_SQL,
  SELECT_DUE_USERS_SQL,
  SELECT_OUTPUTS_SQL,
  SELECT_SESSIONS_SQL,
  SELECT_TASKS_SQL,
  SELECT_USER_BY_EMAIL_SQL,
  SELECT_USER_BY_ID_FOR_UPDATE_SQL,
  SELECT_USER_BY_ID_SQL,
  UnknownUserError,
  closeAccount,
  erasedEmail,
  formatMysqlDateTime,
  loginWithPassword,
  parsePurgeArgs,
  purgeDeletedAccounts,
  referencedObjectKey,
  requireOpenUser,
  type ErasureConnection,
} from '../src/services/account-erasure.js';

const NOW = new Date('2026-10-26T00:00:00.000Z');
const DUE_AT = formatMysqlDateTime(new Date(NOW.getTime() - 30 * DAY_MS));
const YOUNG_AT = formatMysqlDateTime(new Date(NOW.getTime() - 29 * DAY_MS));

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  credits: number;
  created_at: string;
  deleted_at: string | null;
};
type TaskRow = { id: string; user_id: string; result_url: string | null; poster_url: string | null };
type OutputRow = { id: string; task_id: string; object_key: string };
type AssetRow = { id: string; user_id: string; url: string };
type RefRow = { task_id: string; asset_id: string };
type SessionRow = { id: string; user_id: string; revoked_at: string | null };
type LedgerRow = { id: string; user_id: string; delta: number; reason: string };
type OrderRow = { id: string; user_id: string; status: string };
type PaymentRow = { id: string; order_id: string; event_id: string };

type Tables = {
  users: UserRow[];
  generation_tasks: TaskRow[];
  task_outputs: OutputRow[];
  assets: AssetRow[];
  generation_refs: RefRow[];
  refresh_tokens: SessionRow[];
  credit_transactions: LedgerRow[];
  orders: OrderRow[];
  payment_events: PaymentRow[];
};

const verifyPassword = async (password: string, hash: string) => password === hash;

function user(partial: Partial<UserRow> & Pick<UserRow, 'id' | 'email'>): UserRow {
  return {
    password_hash: 'secret',
    display_name: partial.email,
    credits: 100,
    created_at: '2026-01-01 00:00:00',
    deleted_at: null,
    ...partial,
  };
}

/** In-memory stand-in. Writes land in the open transaction and become visible only after commit. */
class FakeAccountDb implements ErasureConnection {
  events: string[] = [];
  failOn: string | null = null;
  private committed: Tables;
  private pending: Tables | null = null;

  constructor(seed: Tables) {
    this.committed = structuredClone(seed);
  }

  get inTransaction(): boolean {
    return this.pending !== null;
  }

  snapshot(): Tables {
    return structuredClone(this.committed);
  }

  async beginTransaction(): Promise<void> {
    if (this.pending) throw new Error('nested transaction');
    this.gate('begin');
    this.pending = structuredClone(this.committed);
  }

  async commit(): Promise<void> {
    if (!this.pending) throw new Error('commit without transaction');
    this.gate('commit');
    this.committed = this.pending;
    this.pending = null;
  }

  async rollback(): Promise<void> {
    this.events.push('rollback');
    this.pending = null;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
    if (/\bDELETE\s+FROM\s+(users|credit_transactions|orders|payment_events)\b/i.test(sql)) {
      throw new Error(`refusing to delete ledger or user rows: ${sql}`);
    }
    const live = this.pending ?? this.committed;
    const write = this.pending;
    const p = params.map((value) => String(value));

    if (sql === SELECT_USER_BY_ID_SQL || sql === SELECT_USER_BY_EMAIL_SQL) {
      this.gate('select-user');
      const row = live.users.find((item) => (sql === SELECT_USER_BY_ID_SQL ? item.id === p[0] : item.email === p[0]));
      return [[row ? { ...row } : undefined].filter(Boolean), []];
    }
    if (sql === SELECT_USER_BY_ID_FOR_UPDATE_SQL) {
      this.gate('lock-close');
      this.requireWrite(sql);
      const row = write!.users.find((item) => item.id === p[0]);
      return [[row ? { ...row } : undefined].filter(Boolean), []];
    }
    if (sql === MARK_DELETED_SQL) {
      this.gate('mark-deleted');
      const row = this.requireWrite(sql).users.find((item) => item.id === p[1]);
      if (!row || row.deleted_at) return [{ affectedRows: 0 }, []];
      row.deleted_at = p[0];
      return [{ affectedRows: 1 }, []];
    }
    if (sql === REVOKE_SESSIONS_SQL) {
      this.gate('revoke');
      let affected = 0;
      for (const session of this.requireWrite(sql).refresh_tokens) {
        if (session.user_id === p[1] && !session.revoked_at) {
          session.revoked_at = p[0];
          affected += 1;
        }
      }
      return [{ affectedRows: affected }, []];
    }
    if (sql === SELECT_DUE_USERS_SQL) {
      this.gate('select-due');
      const rows = live.users
        .filter((item) => item.deleted_at != null && item.deleted_at <= p[0])
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({ id: item.id }));
      return [rows, []];
    }
    if (sql === LOCK_DUE_USER_SQL) {
      this.gate('lock-due');
      this.requireWrite(sql);
      const row = write!.users.find((item) => item.id === p[0] && item.deleted_at != null && item.deleted_at <= p[1]);
      return [[row ? { id: row.id, deleted_at: row.deleted_at } : undefined].filter(Boolean), []];
    }
    if (sql === SELECT_TASKS_SQL) {
      this.gate('select-tasks');
      return [live.generation_tasks.filter((item) => item.user_id === p[0]).map((item) => ({ ...item })), []];
    }
    if (sql === SELECT_OUTPUTS_SQL) {
      this.gate('select-outputs');
      const taskIds = new Set(live.generation_tasks.filter((item) => item.user_id === p[0]).map((item) => item.id));
      return [live.task_outputs.filter((item) => taskIds.has(item.task_id)).map((item) => ({ object_key: item.object_key })), []];
    }
    if (sql === SELECT_ASSETS_SQL) {
      this.gate('select-assets');
      return [live.assets.filter((item) => item.user_id === p[0]).map((item) => ({ object_key: item.url })), []];
    }
    if (sql === SELECT_SESSIONS_SQL) {
      this.gate('select-sessions');
      return [live.refresh_tokens.filter((item) => item.user_id === p[0]).map((item) => ({ id: item.id })), []];
    }
    if (sql === DELETE_TASK_REFS_SQL) return this.deleteRefs(sql, 'task', p[0]);
    if (sql === DELETE_ASSET_REFS_SQL) return this.deleteRefs(sql, 'asset', p[0]);
    if (sql === DELETE_OUTPUTS_SQL) {
      this.gate('delete-outputs');
      const table = this.requireWrite(sql);
      const taskIds = new Set(table.generation_tasks.filter((item) => item.user_id === p[0]).map((item) => item.id));
      return [this.removeWhere(table.task_outputs, (item) => taskIds.has(item.task_id)), []];
    }
    if (sql === DELETE_TASKS_SQL) {
      this.gate('delete-tasks');
      const table = this.requireWrite(sql);
      return [this.removeWhere(table.generation_tasks, (item) => item.user_id === p[0]), []];
    }
    if (sql === DELETE_ASSETS_SQL) {
      this.gate('delete-assets');
      const table = this.requireWrite(sql);
      return [this.removeWhere(table.assets, (item) => item.user_id === p[0]), []];
    }
    if (sql === DELETE_SESSIONS_SQL) {
      this.gate('delete-sessions');
      const table = this.requireWrite(sql);
      return [this.removeWhere(table.refresh_tokens, (item) => item.user_id === p[0]), []];
    }
    if (sql === ANONYMIZE_USER_SQL) {
      this.gate('anonymize');
      const row = this.requireWrite(sql).users.find((item) => item.id === p[2] && item.deleted_at);
      if (!row) return [{ affectedRows: 0 }, []];
      row.email = p[0];
      row.password_hash = p[1];
      row.display_name = null;
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }

  private deleteRefs(sql: string, side: 'task' | 'asset', userId: string): unknown {
    this.gate(side === 'task' ? 'delete-task-refs' : 'delete-asset-refs');
    const table = this.requireWrite(sql);
    const ids = new Set(
      (side === 'task' ? table.generation_tasks.filter((item) => item.user_id === userId).map((item) => item.id)
        : table.assets.filter((item) => item.user_id === userId).map((item) => item.id)),
    );
    return [this.removeWhere(table.generation_refs, (item) => ids.has(side === 'task' ? item.task_id : item.asset_id)), []];
  }

  private removeWhere<T>(rows: T[], match: (row: T) => boolean): { affectedRows: number } {
    const before = rows.length;
    const kept = rows.filter((row) => !match(row));
    rows.splice(0, rows.length, ...kept);
    return { affectedRows: before - kept.length };
  }

  private requireWrite(sql: string): Tables {
    if (!this.pending) throw new Error(`write outside transaction: ${sql}`);
    return this.pending;
  }

  private gate(name: string) {
    this.events.push(name);
    if (this.failOn === name) throw new Error(`${name} failed`);
  }
}

function emptyTables(): Tables {
  return {
    users: [],
    generation_tasks: [],
    task_outputs: [],
    assets: [],
    generation_refs: [],
    refresh_tokens: [],
    credit_transactions: [],
    orders: [],
    payment_events: [],
  };
}

function closureFixture(): FakeAccountDb {
  return new FakeAccountDb({
    ...emptyTables(),
    users: [user({ id: 'user-ada', email: 'ada@example.com', display_name: 'Ada', credits: 40 })],
    refresh_tokens: [
      { id: 's-ada-1', user_id: 'user-ada', revoked_at: null },
      { id: 's-ada-2', user_id: 'user-ada', revoked_at: null },
      { id: 's-other', user_id: 'user-open', revoked_at: null },
    ],
    credit_transactions: [{ id: 'tx-ada', user_id: 'user-ada', delta: 1000, reason: '注册赠送' }],
  });
}

function purgeFixture(): FakeAccountDb {
  return new FakeAccountDb({
    users: [
      user({ id: 'user-due', email: 'due@example.com', display_name: 'Due', credits: 250, deleted_at: DUE_AT }),
      user({ id: 'user-young', email: 'young@example.com', display_name: 'Young', credits: 80, deleted_at: YOUNG_AT }),
      user({ id: 'user-open', email: 'open@example.com', display_name: 'Open', credits: 15 }),
    ],
    generation_tasks: [
      { id: 'task-due', user_id: 'user-due', result_url: 'outputs/due/legacy.png', poster_url: 'https://cdn.example/poster.jpg' },
      { id: 'task-young', user_id: 'user-young', result_url: 'outputs/young/legacy.png', poster_url: null },
      { id: 'task-open', user_id: 'user-open', result_url: 'outputs/open/c.png', poster_url: null },
    ],
    task_outputs: [
      { id: 'out-due', task_id: 'task-due', object_key: 'outputs/due/a.png' },
      { id: 'out-young', task_id: 'task-young', object_key: 'outputs/young/a.png' },
      { id: 'out-open', task_id: 'task-open', object_key: 'outputs/open/c.png' },
    ],
    assets: [
      { id: 'asset-due', user_id: 'user-due', url: 'uploads/due/b.png' },
      { id: 'asset-young', user_id: 'user-young', url: 'uploads/young/b.png' },
    ],
    generation_refs: [
      { task_id: 'task-due', asset_id: 'asset-due' },
      { task_id: 'task-young', asset_id: 'asset-young' },
    ],
    refresh_tokens: [
      { id: 's-due', user_id: 'user-due', revoked_at: DUE_AT },
      { id: 's-young', user_id: 'user-young', revoked_at: null },
      { id: 's-open', user_id: 'user-open', revoked_at: null },
    ],
    credit_transactions: [
      { id: 'tx-due', user_id: 'user-due', delta: -20, reason: '生成扣费' },
      { id: 'tx-young', user_id: 'user-young', delta: 1000, reason: '注册赠送' },
      { id: 'tx-open', user_id: 'user-open', delta: 1000, reason: '注册赠送' },
    ],
    orders: [
      { id: 'order-due', user_id: 'user-due', status: 'paid' },
      { id: 'order-open', user_id: 'user-open', status: 'pending' },
    ],
    payment_events: [{ id: 'pay-due', order_id: 'order-due', event_id: 'evt-1' }],
  });
}

function remover(db: FakeAccountDb, removed: string[]) {
  return {
    async remove(key: string) {
      if (db.inTransaction) throw new Error(`object deleted before commit: ${key}`);
      removed.push(key);
    },
  };
}

describe('account close', () => {
  it('密码错误不写 deleted_at，也不撤销会话', async () => {
    const db = closureFixture();
    const before = db.snapshot();

    await expect(
      closeAccount(db, { userId: 'user-ada', password: '', now: NOW, verifyPassword }),
    ).rejects.toBeInstanceOf(BadPasswordError);
    await expect(
      closeAccount(db, { userId: 'user-ada', password: 'wrong', now: NOW, verifyPassword }),
    ).rejects.toBeInstanceOf(BadPasswordError);

    expect(db.events).toEqual(['select-user']);
    expect(db.snapshot()).toEqual(before);
    expect(db.snapshot().users[0]?.deleted_at).toBeNull();
    expect(db.snapshot().refresh_tokens.every((session) => session.revoked_at == null)).toBe(true);
  });

  it('注销后不能登录或刷新，重复注销不把 deleted_at 往后改', async () => {
    const db = closureFixture();
    const firstAt = new Date('2026-10-01T00:00:00.000Z');
    const later = new Date('2026-10-20T12:00:00.000Z');

    const loggedIn = await loginWithPassword(db, {
      email: 'ada@example.com',
      password: 'secret',
      verifyPassword,
    });
    expect(loggedIn.id).toBe('user-ada');

    const closed = await closeAccount(db, {
      userId: 'user-ada',
      password: 'secret',
      now: firstAt,
      verifyPassword,
    });
    expect(closed).toEqual({ deletedAt: '2026-10-01 00:00:00', alreadyClosed: false });

    await expect(
      loginWithPassword(db, { email: 'ada@example.com', password: 'secret', verifyPassword }),
    ).rejects.toBeInstanceOf(AccountClosedError);
    await expect(requireOpenUser(db, 'user-ada')).rejects.toBeInstanceOf(AccountClosedError);

    const again = await closeAccount(db, {
      userId: 'user-ada',
      password: 'secret',
      now: later,
      verifyPassword,
    });
    expect(again).toEqual({ deletedAt: '2026-10-01 00:00:00', alreadyClosed: true });

    const saved = db.snapshot();
    expect(saved.users[0]).toMatchObject({
      id: 'user-ada',
      email: 'ada@example.com',
      password_hash: 'secret',
      display_name: 'Ada',
      credits: 40,
      deleted_at: '2026-10-01 00:00:00',
    });
    expect(saved.refresh_tokens.filter((session) => session.user_id === 'user-ada').map((session) => session.revoked_at)).toEqual([
      '2026-10-01 00:00:00',
      '2026-10-01 00:00:00',
    ]);
    expect(saved.refresh_tokens.find((session) => session.id === 's-other')?.revoked_at).toBeNull();
    expect(saved.credit_transactions).toEqual([{ id: 'tx-ada', user_id: 'user-ada', delta: 1000, reason: '注册赠送' }]);
    expect(db.events.filter((event) => event === 'mark-deleted')).toEqual(['mark-deleted']);
  });
});

describe('purge deleted accounts', () => {
  it('defaults to dry-run and rejects unknown flags', () => {
    expect(parsePurgeArgs([])).toEqual({ apply: false, retentionDays: 30 });
    expect(parsePurgeArgs(['--apply'])).toEqual({ apply: true, retentionDays: 30 });
    expect(() => parsePurgeArgs(['--drop'])).toThrow(/未知参数/);
    expect(referencedObjectKey('outputs/due/a.png')).toBe('outputs/due/a.png');
    expect(referencedObjectKey('https://cdn.example/poster.jpg')).toBeNull();
    expect(referencedObjectKey('../etc/passwd')).toBeNull();
    expect(erasedEmail('user-due')).toBe('erased:user-due');
    expect(erasedEmail('user-due')).not.toMatch(/@/);
  });

  it('dry-run 只报告满 30 天的用户，不删数据也不删对象', async () => {
    const db = purgeFixture();
    const before = db.snapshot();
    const removed: string[] = [];

    const report = await purgeDeletedAccounts(db, { apply: false, now: NOW }, remover(db, removed));

    expect(report).toMatchObject({
      mode: 'dry-run',
      retentionDays: 30,
      cutoff: DUE_AT,
      userIds: ['user-due'],
      tasks: 1,
      outputs: 1,
      assets: 1,
      sessions: 1,
      anonymized: 0,
      objectKeys: ['outputs/due/a.png', 'outputs/due/legacy.png', 'uploads/due/b.png'],
    });
    expect(removed).toEqual([]);
    expect(db.snapshot()).toEqual(before);
    expect(db.events.some((event) => event === 'begin' || event.startsWith('delete') || event === 'anonymize')).toBe(false);
  });

  it('未满 30 天的注销用户不删除', async () => {
    const onlyYoung = new FakeAccountDb({
      ...emptyTables(),
      users: [user({ id: 'user-young', email: 'young@example.com', display_name: 'Young', deleted_at: YOUNG_AT })],
      generation_tasks: [{ id: 'task-young', user_id: 'user-young', result_url: 'outputs/young/legacy.png', poster_url: null }],
      task_outputs: [{ id: 'out-young', task_id: 'task-young', object_key: 'outputs/young/a.png' }],
      assets: [{ id: 'asset-young', user_id: 'user-young', url: 'uploads/young/b.png' }],
      refresh_tokens: [{ id: 's-young', user_id: 'user-young', revoked_at: null }],
      credit_transactions: [{ id: 'tx-young', user_id: 'user-young', delta: 1000, reason: '注册赠送' }],
    });
    const before = onlyYoung.snapshot();
    const removed: string[] = [];

    const report = await purgeDeletedAccounts(onlyYoung, { apply: true, now: NOW }, remover(onlyYoung, removed));

    expect(report).toMatchObject({ mode: 'apply', userIds: [], tasks: 0, anonymized: 0, objectKeys: [] });
    expect(removed).toEqual([]);
    expect(onlyYoung.snapshot()).toEqual(before);
    await expect(
      loginWithPassword(onlyYoung, { email: 'young@example.com', password: 'secret', verifyPassword }),
    ).rejects.toBeInstanceOf(AccountClosedError);
  });

  it('满 30 天只删除任务和产物并匿名，账本和用户行还在', async () => {
    const db = purgeFixture();
    const removed: string[] = [];

    const report = await purgeDeletedAccounts(db, { apply: true, now: NOW }, remover(db, removed));

    expect(report).toMatchObject({
      mode: 'apply',
      userIds: ['user-due'],
      tasks: 1,
      outputs: 1,
      assets: 1,
      sessions: 1,
      anonymized: 1,
      objectKeys: ['outputs/due/a.png', 'outputs/due/legacy.png', 'uploads/due/b.png'],
    });
    expect(removed).toEqual(['outputs/due/a.png', 'outputs/due/legacy.png', 'uploads/due/b.png']);
    expect(removed).not.toContain('https://cdn.example/poster.jpg');
    expect(removed).not.toContain('outputs/young/a.png');
    expect(removed).not.toContain('outputs/open/c.png');

    const saved = db.snapshot();
    expect(saved.users.map((item) => item.id)).toEqual(['user-due', 'user-young', 'user-open']);
    expect(saved.users.find((item) => item.id === 'user-due')).toEqual({
      id: 'user-due',
      email: 'erased:user-due',
      password_hash: CLEARED_PASSWORD_HASH,
      display_name: null,
      credits: 250,
      created_at: '2026-01-01 00:00:00',
      deleted_at: DUE_AT,
    });
    expect(saved.generation_tasks.map((item) => item.id)).toEqual(['task-young', 'task-open']);
    expect(saved.task_outputs.map((item) => item.id)).toEqual(['out-young', 'out-open']);
    expect(saved.assets.map((item) => item.id)).toEqual(['asset-young']);
    expect(saved.generation_refs).toEqual([{ task_id: 'task-young', asset_id: 'asset-young' }]);
    expect(saved.refresh_tokens.map((item) => item.id)).toEqual(['s-young', 's-open']);
    expect(saved.credit_transactions).toEqual([
      { id: 'tx-due', user_id: 'user-due', delta: -20, reason: '生成扣费' },
      { id: 'tx-young', user_id: 'user-young', delta: 1000, reason: '注册赠送' },
      { id: 'tx-open', user_id: 'user-open', delta: 1000, reason: '注册赠送' },
    ]);
    expect(saved.orders).toEqual([
      { id: 'order-due', user_id: 'user-due', status: 'paid' },
      { id: 'order-open', user_id: 'user-open', status: 'pending' },
    ]);
    expect(saved.payment_events).toEqual([{ id: 'pay-due', order_id: 'order-due', event_id: 'evt-1' }]);
    expect(saved.users.find((item) => item.id === 'user-young')).toMatchObject({
      email: 'young@example.com',
      display_name: 'Young',
      deleted_at: YOUNG_AT,
    });
    expect(saved.users.find((item) => item.id === 'user-open')?.email).toBe('open@example.com');

    await expect(
      loginWithPassword(db, { email: 'due@example.com', password: 'secret', verifyPassword }),
    ).rejects.toBeInstanceOf(UnknownUserError);
    await expect(
      loginWithPassword(db, { email: erasedEmail('user-due'), password: 'secret', verifyPassword }),
    ).rejects.toBeInstanceOf(AccountClosedError);
    const open = await loginWithPassword(db, { email: 'open@example.com', password: 'secret', verifyPassword });
    expect(open.id).toBe('user-open');
  });

  it('数据库删除失败则回滚，并且不删对象', async () => {
    const db = purgeFixture();
    const before = db.snapshot();
    const removed: string[] = [];
    db.failOn = 'delete-tasks';

    await expect(purgeDeletedAccounts(db, { apply: true, now: NOW }, remover(db, removed))).rejects.toThrow(/delete-tasks failed/);

    expect(removed).toEqual([]);
    expect(db.inTransaction).toBe(false);
    expect(db.snapshot()).toEqual(before);
    expect(db.events).toContain('rollback');
    expect(db.events).not.toContain('commit');
  });
});

describe('0009 account erasure migration', () => {
  const sql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations/0009_account_erasure.sql'),
    'utf8',
  );
  const statements = sql.replace(/--.*$/gm, '');

  it('adds a nullable deleted_at and can be applied twice', () => {
    expect(statements).toMatch(/information_schema\.COLUMNS/);
    expect(statements).toMatch(/ADD COLUMN deleted_at DATETIME NULL/);
    expect(statements).toMatch(/information_schema\.STATISTICS/);
    expect(statements).toMatch(/CREATE INDEX idx_users_deleted_at ON users \(deleted_at\)/);
    expect(statements).toMatch(/PREPARE stmt FROM @sql/);
    expect(statements).not.toMatch(/\b(DROP|DELETE|PARTITION)\b/i);
    expect(statements).not.toMatch(/\bFOREIGN\s+KEY\b/i);
    expect(statements).not.toMatch(/\bREFERENCES\b/i);
    for (const statement of [
      DELETE_TASKS_SQL,
      DELETE_OUTPUTS_SQL,
      DELETE_ASSETS_SQL,
      DELETE_SESSIONS_SQL,
      DELETE_TASK_REFS_SQL,
      DELETE_ASSET_REFS_SQL,
      ANONYMIZE_USER_SQL,
      MARK_DELETED_SQL,
    ]) {
      expect(statement).not.toMatch(/\bDELETE\s+FROM\s+(users|credit_transactions|orders|payment_events)\b/i);
    }
    expect(MARK_DELETED_SQL).toContain('deleted_at IS NULL');
    expect(ANONYMIZE_USER_SQL).not.toMatch(/deleted_at\s*=/);
  });
});

describe('closed account lookup', () => {
  it('rejects a missing refresh user', async () => {
    const db = closureFixture();
    await expect(requireOpenUser(db, 'missing')).rejects.toBeInstanceOf(AccountMissingError);
  });
});
