import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COUNT_EXPIRED_SQL,
  DELETE_ARCHIVED_SQL,
  INSERT_ARCHIVE_SQL,
  archiveAuditLogs,
  formatMysqlDateTime,
  parseArchiveArgs,
  type ArchiveConnection,
} from '../src/scripts/archive-audit-logs-lib.js';

type AuditRow = {
  id: number;
  org_id: string | null;
  user_id: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  ua: string | null;
  meta: string | null;
  created_at: string;
};

const NOW = new Date('2026-10-26T00:00:00.000Z');

function row(id: number, createdAt: string, action = 'user.login'): AuditRow {
  return {
    id,
    org_id: 'org-1',
    user_id: 'user-1',
    action,
    target: `target-${id}`,
    ip: '127.0.0.1',
    ua: 'vitest',
    meta: JSON.stringify({ id }),
    created_at: createdAt,
  };
}

/** In-memory stand-in for mysql2's [rows | header, fields] results. Mutations commit only with the transaction. */
class FakeAuditConnection implements ArchiveConnection {
  hot: AuditRow[];
  archive: AuditRow[];
  events: string[] = [];
  failOn: 'count' | 'insert' | 'delete' | null = null;
  private pending: { hot: AuditRow[]; archive: AuditRow[] } | null = null;

  constructor(hot: AuditRow[], archive: AuditRow[] = []) {
    this.hot = hot.map((item) => ({ ...item }));
    this.archive = archive.map((item) => ({ ...item }));
  }

  async beginTransaction(): Promise<void> {
    this.events.push('begin');
    this.pending = {
      hot: this.hot.map((item) => ({ ...item })),
      archive: this.archive.map((item) => ({ ...item })),
    };
  }

  async commit(): Promise<void> {
    if (!this.pending) throw new Error('commit without transaction');
    this.events.push('commit');
    this.hot = this.pending.hot;
    this.archive = this.pending.archive;
    this.pending = null;
  }

  async rollback(): Promise<void> {
    this.events.push('rollback');
    this.pending = null;
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown> {
    const cutoff = String(params[0] ?? '');
    if (sql === COUNT_EXPIRED_SQL) {
      this.events.push('count');
      if (this.failOn === 'count') throw new Error('connect ECONNREFUSED');
      const source = this.pending?.hot ?? this.hot;
      return [[{ expired_count: source.filter((item) => item.created_at < cutoff).length }], []];
    }
    if (sql === INSERT_ARCHIVE_SQL) {
      this.events.push('insert');
      if (!this.pending) throw new Error('insert outside transaction');
      if (this.failOn === 'insert') throw new Error('insert failed');
      const seen = new Set(this.pending.archive.map((item) => item.id));
      let inserted = 0;
      for (const item of this.pending.hot) {
        if (item.created_at >= cutoff || seen.has(item.id)) continue;
        this.pending.archive.push({ ...item });
        seen.add(item.id);
        inserted += 1;
      }
      return [{ affectedRows: inserted }, []];
    }
    if (sql === DELETE_ARCHIVED_SQL) {
      this.events.push('delete');
      if (!this.pending) throw new Error('delete outside transaction');
      if (this.failOn === 'delete') throw new Error('delete failed');
      const archived = new Set(this.pending.archive.map((item) => item.id));
      const before = this.pending.hot.length;
      this.pending.hot = this.pending.hot.filter((item) => !(item.created_at < cutoff && archived.has(item.id)));
      return [{ affectedRows: before - this.pending.hot.length }, []];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }
}

describe('audit log cold archive', () => {
  const expiredAt = '2026-04-28 23:59:59';
  const cutoffAt = formatMysqlDateTime(new Date(NOW.getTime() - 180 * 86_400_000));
  const freshAt = '2026-10-25 00:00:00';

  it('parses dry-run as the default and accepts a retention override', () => {
    expect(parseArchiveArgs([])).toEqual({ apply: false, retentionDays: 180 });
    expect(parseArchiveArgs(['--apply', '--retention-days', '30'])).toEqual({ apply: true, retentionDays: 30 });
    expect(() => parseArchiveArgs(['--retention-days'])).toThrow(/缺少/);
    expect(() => parseArchiveArgs(['--retention-days', '1.5'])).toThrow(/非负整数/);
  });

  it('does not delete or write on dry-run', async () => {
    const db = new FakeAuditConnection([row(1, expiredAt), row(2, freshAt)]);
    const report = await archiveAuditLogs(db, { apply: false, retentionDays: 180, now: NOW });

    expect(report).toMatchObject({ mode: 'dry-run', expired: 1, inserted: 0, deleted: 0 });
    expect(db.events).toEqual(['count']);
    expect(db.hot.map((item) => item.id)).toEqual([1, 2]);
    expect(db.archive).toEqual([]);
  });

  it('moves only expired rows and leaves newer rows on the hot table', async () => {
    const expired = row(1, expiredAt);
    const boundary = row(2, cutoffAt, 'boundary');
    const fresh = row(3, freshAt, 'fresh');
    const db = new FakeAuditConnection([expired, boundary, fresh]);

    const report = await archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW });

    expect(report).toMatchObject({ mode: 'apply', expired: 1, inserted: 1, deleted: 1 });
    expect(db.events).toEqual(['count', 'begin', 'insert', 'delete', 'commit']);
    expect(db.archive).toEqual([expired]);
    expect(db.hot).toEqual([boundary, fresh]);
  });

  it('does not insert a second archive copy when run again', async () => {
    const expired = row(1, expiredAt);
    const fresh = row(2, freshAt);
    const db = new FakeAuditConnection([expired, fresh]);

    await archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW });
    const again = await archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW });

    expect(again).toMatchObject({ expired: 0, inserted: 0, deleted: 0 });
    expect(db.archive).toEqual([expired]);
    expect(db.hot).toEqual([fresh]);
  });

  it('deletes a hot duplicate without inserting a second archived row', async () => {
    const expired = row(1, expiredAt);
    const db = new FakeAuditConnection([expired, row(2, freshAt)], [expired]);

    const report = await archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW });

    expect(report).toMatchObject({ inserted: 0, deleted: 1 });
    expect(db.archive).toEqual([expired]);
    expect(db.hot.map((item) => item.id)).toEqual([2]);
  });

  it('honours a shorter retention window', async () => {
    const twoDaysOld = row(1, '2026-10-24 00:00:00');
    const today = row(2, '2026-10-26 00:00:00');
    const db = new FakeAuditConnection([twoDaysOld, today]);

    await archiveAuditLogs(db, { apply: true, retentionDays: 1, now: NOW });

    expect(db.archive).toEqual([twoDaysOld]);
    expect(db.hot).toEqual([today]);
  });

  it('fails closed when the database cannot be queried and does not delete', async () => {
    const db = new FakeAuditConnection([row(1, expiredAt)]);
    db.failOn = 'count';

    await expect(archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW })).rejects.toThrow(/ECONNREFUSED/);
    expect(db.events).toEqual(['count']);
    expect(db.hot).toHaveLength(1);
    expect(db.archive).toEqual([]);
  });

  it('rolls back the hot-table delete when the insert fails', async () => {
    const db = new FakeAuditConnection([row(1, expiredAt), row(2, freshAt)]);
    db.failOn = 'insert';

    await expect(archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW })).rejects.toThrow(/insert failed/);
    expect(db.events).toEqual(['count', 'begin', 'insert', 'rollback']);
    expect(db.hot.map((item) => item.id)).toEqual([1, 2]);
    expect(db.archive).toEqual([]);
  });

  it('rolls back the archive insert when the delete fails', async () => {
    const db = new FakeAuditConnection([row(1, expiredAt)]);
    db.failOn = 'delete';

    await expect(archiveAuditLogs(db, { apply: true, retentionDays: 180, now: NOW })).rejects.toThrow(/delete failed/);
    expect(db.events).toEqual(['count', 'begin', 'insert', 'delete', 'rollback']);
    expect(db.hot.map((item) => item.id)).toEqual([1]);
    expect(db.archive).toEqual([]);
  });
});

describe('0008 audit_logs archive migration', () => {
  const migrationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/db/migrations/0008_audit_logs_archive.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');
  const statements = sql.replace(/--.*$/gm, '');

  it('creates a re-entrant archive table with the hot primary key and no foreign keys', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_logs_archive \(/);
    expect(statements).toMatch(/id\s+BIGINT AUTO_INCREMENT PRIMARY KEY/);
    expect(statements).not.toMatch(/FOREIGN KEY/i);
    expect(statements).not.toMatch(/\bREFERENCES\b/i);
    expect(statements).not.toMatch(/\b(DROP|ALTER|DELETE|PARTITION)\b/i);
    expect(sql).not.toMatch(/generation_tasks|credit_transactions|\borders\b/);
    for (const column of ['org_id', 'user_id', 'action', 'target', 'ip', 'ua', 'meta', 'created_at']) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('KEY idx_audit_user (user_id, created_at)');
    expect(sql).toContain('KEY idx_audit_action (action, created_at)');
    expect(sql).toContain('KEY idx_audit_org (org_id, created_at)');
  });

  it('keeps the move statements on audit_logs only', () => {
    for (const statement of [COUNT_EXPIRED_SQL, INSERT_ARCHIVE_SQL, DELETE_ARCHIVED_SQL]) {
      expect(statement).not.toMatch(/generation_tasks|credit_transactions|\borders\b/);
      expect(statement).not.toMatch(/FOREIGN KEY/i);
    }
    expect(COUNT_EXPIRED_SQL).not.toMatch(/INSERT|DELETE/);
    expect(INSERT_ARCHIVE_SQL).toMatch(/INSERT IGNORE INTO audit_logs_archive/);
    expect(INSERT_ARCHIVE_SQL).toMatch(/FROM audit_logs WHERE created_at < \?/);
    expect(DELETE_ARCHIVED_SQL).toMatch(/INNER JOIN audit_logs_archive/);
    expect(DELETE_ARCHIVED_SQL).toMatch(/hot\.created_at < \?/);
  });
});
