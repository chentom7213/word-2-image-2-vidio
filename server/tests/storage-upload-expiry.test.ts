import { describe, expect, it } from 'vitest';
import {
  ASSET_AGES_SQL,
  DAY_MS,
  DETACH_SQL,
  LEGACY_AGES_SQL,
  OUTPUT_AGES_SQL,
  assertLocalStorageDriver,
  loadUploadAges,
  parseUploadExpiryArgs,
  readUploadExpiryEnabled,
  runUploadExpiry,
  type SqlQuery,
  type UploadExpiryStore,
  type UploadExpiryTransaction,
} from '../src/scripts/storage-upload-expiry-lib.js';

const NOW = Date.parse('2026-10-26T00:00:00.000Z');

function aged(body: string, ageDays: number) {
  return { body, modifiedAtMs: NOW - ageDays * DAY_MS };
}

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function memoryStore(initial: Record<string, { body: string; modifiedAtMs: number }>) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
  const removed: string[] = [];
  let listCalls = 0;
  const store: UploadExpiryStore = {
    list() {
      listCalls += 1;
      return [...objects.entries()].map(([objectKey, value]) => ({
        objectKey,
        modifiedAtMs: value.modifiedAtMs,
      }));
    },
    remove(objectKey) {
      if (!objects.has(objectKey)) throw new Error(`missing ${objectKey}`);
      objects.delete(objectKey);
      removed.push(objectKey);
    },
  };
  return {
    store,
    removed,
    listCalls: () => listCalls,
    snapshot() {
      return Object.fromEntries(
        [...objects.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, value.body]),
      );
    },
  };
}

function recordingTransaction(failKey?: string): {
  transaction: UploadExpiryTransaction;
  statements: { sql: string; objectKey: string }[];
  events: string[];
} {
  const statements: { sql: string; objectKey: string }[] = [];
  const events: string[] = [];
  const transaction: UploadExpiryTransaction = async (fn) => {
    events.push('begin');
    await fn({
      execute: async (sql, params) => {
        if (params[0] === failKey) throw new Error(`deadlock ${params[0]}`);
        events.push(`sql ${params[0]}`);
        statements.push({ sql, objectKey: params[0] });
      },
    });
    events.push('commit');
  };
  return { transaction, statements, events };
}

describe('storage upload expiry', () => {
  it('does not delete on the default dry-run', async () => {
    expect(parseUploadExpiryArgs([]).command).toBe('dry-run');
    expect(parseUploadExpiryArgs(['--json']).command).toBe('dry-run');
    expect(readUploadExpiryEnabled({})).toBe(false);
    expect(readUploadExpiryEnabled({ STORAGE_UPLOAD_EXPIRY: '' })).toBe(false);
    expect(readUploadExpiryEnabled({ STORAGE_UPLOAD_EXPIRY: '1' })).toBe(true);

    for (const enabled of [false, true]) {
      const mem = memoryStore({
        'uploads/user/old.png': aged('upload', 400),
        'outputs/user/old.png': aged('output', 400),
      });
      const before = mem.snapshot();
      let transacted = false;
      const report = await runUploadExpiry({
        command: 'dry-run',
        enabled,
        driver: 'local',
        now: NOW,
        store: mem.store,
        loadAges: async () => [],
        transaction: async () => {
          transacted = true;
        },
      });
      expect(report.mode).toBe('dry-run');
      expect(report.enabled).toBe(enabled);
      expect(report.deleted).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(report.planned.map((item) => item.objectKey)).toEqual(['uploads/user/old.png']);
      expect(transacted).toBe(false);
      expect(mem.removed).toEqual([]);
      expect(mem.snapshot()).toEqual(before);
    }
  });

  it('rejects apply when STORAGE_UPLOAD_EXPIRY is not exactly 1 and keeps the file', async () => {
    expect(parseUploadExpiryArgs(['--apply']).command).toBe('apply');
    expect(() => parseUploadExpiryArgs(['--purge'])).toThrow(/未知参数/);
    for (const raw of [undefined, '', 'true', 'yes', '1 ', '0'] as const) {
      expect(readUploadExpiryEnabled({ STORAGE_UPLOAD_EXPIRY: raw })).toBe(false);
    }

    for (const raw of ['true', 'yes', '1 '] as const) {
      const mem = memoryStore({ 'uploads/user/old.png': aged('upload', 400) });
      const before = mem.snapshot();
      let queried = false;
      await expect(runUploadExpiry({
        command: 'apply',
        enabled: readUploadExpiryEnabled({ STORAGE_UPLOAD_EXPIRY: raw }),
        driver: 'local',
        now: NOW,
        store: mem.store,
        loadAges: async () => {
          queried = true;
          return [];
        },
        transaction: async () => {
          throw new Error('should not transact');
        },
      })).rejects.toThrow(/STORAGE_UPLOAD_EXPIRY 不是 1，拒绝执行 apply，未删除任何文件，未修改数据库/);
      expect(queried).toBe(false);
      expect(mem.listCalls()).toBe(0);
      expect(mem.removed).toEqual([]);
      expect(mem.snapshot()).toEqual(before);
    }
  });

  it('deletes uploads and archive uploads once they are 365 days old, including referenced ones', async () => {
    const mem = memoryStore({
      'uploads/user/at-365.png': aged('hot', 365),
      'archive/uploads/user/at-365.png': aged('archived', 365),
      'infrequent/uploads/user/at-365.png': aged('cold', 365),
      'uploads/user/referenced.png': aged('referenced', 1),
      'infrequent/uploads/user/from-task.png': aged('from-task', 1),
      'archive/uploads/user/from-result.png': aged('from-result', 1),
      'uploads/user/from-poster.png': aged('from-poster', 1),
    });
    const recorded = recordingTransaction();
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: {
        list: () => mem.store.list(),
        remove(objectKey) {
          recorded.events.push(`rm ${objectKey}`);
          mem.store.remove(objectKey);
        },
      },
      loadAges: () => loadUploadAges(async (sql) => {
        if (sql === ASSET_AGES_SQL) {
          return [
            { object_key: 'uploads/user/referenced.png', created_at: daysAgo(400) },
            { object_key: 'uploads/user/referenced.png', created_at: daysAgo(10) },
          ];
        }
        if (sql === OUTPUT_AGES_SQL) {
          return [{ object_key: 'infrequent/uploads/user/from-task.png', created_at: daysAgo(365) }];
        }
        if (sql === LEGACY_AGES_SQL) {
          return [{
            result_url: 'archive/uploads/user/from-result.png',
            poster_url: 'uploads/user/from-poster.png',
            created_at: daysAgo(400),
          }];
        }
        throw new Error(`unexpected ${sql}`);
      }),
      transaction: recorded.transaction,
    });

    expect(report.failures).toEqual([]);
    expect(report.deleted).toEqual([
      'archive/uploads/user/at-365.png',
      'archive/uploads/user/from-result.png',
      'infrequent/uploads/user/at-365.png',
      'infrequent/uploads/user/from-task.png',
      'uploads/user/at-365.png',
      'uploads/user/from-poster.png',
      'uploads/user/referenced.png',
    ]);
    expect(report.planned.find((item) => item.objectKey === 'uploads/user/at-365.png')).toMatchObject({
      ageDays: 365,
      ageSource: 'mtime',
    });
    expect(report.planned.find((item) => item.objectKey === 'archive/uploads/user/at-365.png')).toMatchObject({
      ageDays: 365,
      ageSource: 'mtime',
    });
    expect(report.planned.find((item) => item.objectKey === 'uploads/user/referenced.png')).toMatchObject({
      ageDays: 400,
      ageSource: 'database',
    });
    expect(mem.snapshot()).toEqual({});
    for (const objectKey of report.deleted) {
      expect(recorded.statements.filter((item) => item.objectKey === objectKey).map((item) => item.sql)).toEqual([
        ...DETACH_SQL,
      ]);
    }
    expect(recorded.statements.some((item) => /generation_refs|canvas/i.test(item.sql))).toBe(false);
    const firstRm = recorded.events.findIndex((event) => event.startsWith('rm '));
    expect(recorded.events.indexOf('commit')).toBeGreaterThan(-1);
    expect(firstRm).toBeGreaterThan(recorded.events.indexOf('commit'));
  });

  it('keeps uploads that are not yet 365 days old', async () => {
    const mem = memoryStore({
      'uploads/user/at-364.png': aged('young-hot', 364),
      'archive/uploads/user/at-364.png': aged('young-archive', 364),
      'infrequent/uploads/user/at-364.png': aged('young-cold', 364),
      'uploads/user/db-young.png': aged('db-young', 400),
      'uploads/user/at-365.png': aged('old', 365),
    });
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: mem.store,
      loadAges: () => loadUploadAges(async (sql) => {
        if (sql === ASSET_AGES_SQL) {
          return [{ object_key: 'uploads/user/db-young.png', created_at: daysAgo(10) }];
        }
        if (sql === OUTPUT_AGES_SQL || sql === LEGACY_AGES_SQL) return [];
        throw new Error(`unexpected ${sql}`);
      }),
      transaction: recordingTransaction().transaction,
    });
    expect(report.failures).toEqual([]);
    expect(report.deleted).toEqual(['uploads/user/at-365.png']);
    expect(mem.snapshot()).toEqual({
      'archive/uploads/user/at-364.png': 'young-archive',
      'infrequent/uploads/user/at-364.png': 'young-cold',
      'uploads/user/at-364.png': 'young-hot',
      'uploads/user/db-young.png': 'db-young',
    });
  });

  it('does not delete outputs or retention-hold, even when they are older', async () => {
    const mem = memoryStore({
      'uploads/user/old.png': aged('upload', 400),
      'outputs/user/old.png': aged('output', 800),
      'infrequent/outputs/user/old.png': aged('cold-output', 800),
      'archive/outputs/user/old.png': aged('archived-output', 800),
      'outputs/uploads/nested.png': aged('nested', 800),
      'retention-hold/outputs/user/old.png': aged('held-output', 800),
      'retention-hold/uploads/user/old.png': aged('held-upload', 800),
      '../uploads/secret.png': aged('dotdot', 800),
      '/uploads/abs.png': aged('abs', 800),
      'C:/uploads/abs.png': aged('drive', 800),
      'https://cdn.example/uploads/a.png': aged('url', 800),
      's3://bucket/uploads/a.png': aged('s3-url', 800),
      'uploads/../../etc/passwd': aged('traverse', 800),
      'archive/uploads/../outputs/escaped.png': aged('escape', 800),
    });
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
      transaction: recordingTransaction().transaction,
    });
    expect(report.failures).toEqual([]);
    expect(report.deleted).toEqual(['uploads/user/old.png']);
    expect(mem.snapshot()).toEqual({
      '../uploads/secret.png': 'dotdot',
      '/uploads/abs.png': 'abs',
      'C:/uploads/abs.png': 'drive',
      'archive/outputs/user/old.png': 'archived-output',
      'archive/uploads/../outputs/escaped.png': 'escape',
      'https://cdn.example/uploads/a.png': 'url',
      'infrequent/outputs/user/old.png': 'cold-output',
      'outputs/uploads/nested.png': 'nested',
      'outputs/user/old.png': 'output',
      'retention-hold/outputs/user/old.png': 'held-output',
      'retention-hold/uploads/user/old.png': 'held-upload',
      's3://bucket/uploads/a.png': 's3-url',
      'uploads/../../etc/passwd': 'traverse',
    });
  });

  it('skips a database key whose timestamp cannot be parsed', async () => {
    const mem = memoryStore({
      'uploads/user/bad-time.png': aged('bad', 400),
      'archive/uploads/user/bad-time.png': aged('bad-archive', 400),
      'uploads/user/orphan.png': aged('orphan', 400),
    });
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: mem.store,
      loadAges: () => loadUploadAges(async (sql) => {
        if (sql === ASSET_AGES_SQL) {
          return [{ object_key: 'uploads/user/bad-time.png', created_at: 'not-a-date' }];
        }
        if (sql === OUTPUT_AGES_SQL) {
          return [{ object_key: 'archive/uploads/user/bad-time.png', created_at: null }];
        }
        if (sql === LEGACY_AGES_SQL) return [];
        throw new Error(`unexpected ${sql}`);
      }),
      transaction: recordingTransaction().transaction,
    });
    expect(report.failures).toEqual([]);
    expect(report.planned.map((item) => item.objectKey)).toEqual(['uploads/user/orphan.png']);
    expect(report.deleted).toEqual(['uploads/user/orphan.png']);
    expect(mem.snapshot()).toEqual({
      'archive/uploads/user/bad-time.png': 'bad-archive',
      'uploads/user/bad-time.png': 'bad',
    });
  });

  it('does not delete when the database query or the listing fails', async () => {
    const query: SqlQuery = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const mem = memoryStore({ 'uploads/user/old.png': aged('pixels', 400) });
    const before = mem.snapshot();
    await expect(runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: mem.store,
      loadAges: () => loadUploadAges(query),
      transaction: async () => {
        throw new Error('should not transact');
      },
    })).rejects.toThrow(/数据库查询失败，已中止，未删除任何文件，未修改数据库: connect ECONNREFUSED/);
    expect(mem.listCalls()).toBe(0);
    expect(mem.removed).toEqual([]);
    expect(mem.snapshot()).toEqual(before);

    const listed = memoryStore({ 'archive/uploads/user/old.png': aged('archived', 400) });
    const listedBefore = listed.snapshot();
    await expect(runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: {
        list() {
          throw new Error('EACCES');
        },
        remove(objectKey) {
          listed.store.remove(objectKey);
        },
      },
      loadAges: async () => [],
      transaction: async () => {
        throw new Error('should not transact');
      },
    })).rejects.toThrow(/对象列举失败，已中止，未删除任何文件，未修改数据库: EACCES/);
    expect(listed.removed).toEqual([]);
    expect(listed.snapshot()).toEqual(listedBefore);
  });

  it('refuses STORAGE_DRIVER=s3 without deleting', async () => {
    expect(() => assertLocalStorageDriver('s3')).toThrow(/桶生命周期/);
    expect(() => assertLocalStorageDriver(' S3 ')).toThrow(/改用桶生命周期/);
    expect(() => assertLocalStorageDriver('local')).not.toThrow();
    expect(() => assertLocalStorageDriver(undefined)).not.toThrow();

    const mem = memoryStore({ 'uploads/user/old.png': aged('upload', 400) });
    const before = mem.snapshot();
    let queried = false;
    await expect(runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 's3',
      now: NOW,
      store: mem.store,
      loadAges: async () => {
        queried = true;
        return [];
      },
      transaction: async () => {
        throw new Error('should not transact');
      },
    })).rejects.toThrow(/改用桶生命周期/);
    expect(queried).toBe(false);
    expect(mem.listCalls()).toBe(0);
    expect(mem.removed).toEqual([]);
    expect(mem.snapshot()).toEqual(before);
  });

  it('does not delete the file when its transaction fails', async () => {
    const mem = memoryStore({
      'uploads/user/a-tx-fail.png': aged('fail', 400),
      'uploads/user/b-ok.png': aged('ok', 400),
    });
    const recorded = recordingTransaction('uploads/user/a-tx-fail.png');
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: {
        list: () => mem.store.list(),
        remove(objectKey) {
          recorded.events.push(`rm ${objectKey}`);
          mem.store.remove(objectKey);
        },
      },
      loadAges: async () => [],
      transaction: recorded.transaction,
    });
    expect(report.deleted).toEqual(['uploads/user/b-ok.png']);
    expect(report.failures).toEqual([
      {
        objectKey: 'uploads/user/a-tx-fail.png',
        phase: 'transaction',
        message: 'deadlock uploads/user/a-tx-fail.png',
      },
    ]);
    expect(recorded.events.some((event) => event === 'rm uploads/user/a-tx-fail.png')).toBe(false);
    expect(mem.snapshot()).toEqual({ 'uploads/user/a-tx-fail.png': 'fail' });
    expect(recorded.statements.map((item) => item.objectKey)).toEqual([
      'uploads/user/b-ok.png',
      'uploads/user/b-ok.png',
      'uploads/user/b-ok.png',
      'uploads/user/b-ok.png',
    ]);
  });

  it('records a file deletion failure and continues with the remaining candidates', async () => {
    const mem = memoryStore({
      'uploads/user/locked.png': aged('locked', 400),
      'uploads/user/ok.png': aged('ok', 400),
    });
    const report = await runUploadExpiry({
      command: 'apply',
      enabled: true,
      driver: 'local',
      now: NOW,
      store: {
        list: () => mem.store.list(),
        remove(objectKey) {
          if (objectKey.endsWith('locked.png')) throw new Error('EPERM');
          mem.store.remove(objectKey);
        },
      },
      loadAges: async () => [],
      transaction: async (fn) => {
        await fn({ execute: async () => {} });
      },
    });
    expect(report.deleted).toEqual(['uploads/user/ok.png']);
    expect(report.failures).toEqual([
      { objectKey: 'uploads/user/locked.png', phase: 'file', message: 'EPERM' },
    ]);
    expect(mem.snapshot()).toEqual({ 'uploads/user/locked.png': 'locked' });
  });
});
