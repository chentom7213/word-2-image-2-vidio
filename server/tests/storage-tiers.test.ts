import { describe, expect, it } from 'vitest';
import {
  ASSET_AGES_SQL,
  DAY_MS,
  LEGACY_AGES_SQL,
  OUTPUT_AGES_SQL,
  TIER_KEY_REWRITE_SQL,
  assertLocalStorageDriver,
  isTierRestore,
  loadTierAges,
  parseTierArgs,
  readTierTransitionsEnabled,
  rewriteTierObjectKey,
  runStorageTiers,
  type SqlQuery,
  type TierStore,
} from '../src/scripts/storage-tiers-lib.js';

const NOW = Date.parse('2026-10-26T00:00:00.000Z');

function aged(body: string, ageDays: number) {
  return { body, modifiedAtMs: NOW - ageDays * DAY_MS };
}

function memoryStore(initial: Record<string, { body: string; modifiedAtMs: number }>) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
  const moves: string[] = [];
  let listCalls = 0;
  const store: TierStore = {
    list() {
      listCalls += 1;
      return [...objects.entries()].map(([objectKey, value]) => ({
        objectKey,
        modifiedAtMs: value.modifiedAtMs,
      }));
    },
    move(fromKey, toKey) {
      const current = objects.get(fromKey);
      if (!current) throw new Error(`missing ${fromKey}`);
      if (objects.has(toKey)) throw new Error(`dest exists ${toKey}`);
      objects.set(toKey, { body: current.body, modifiedAtMs: current.modifiedAtMs });
      objects.delete(fromKey);
      moves.push(`${fromKey} -> ${toKey}`);
    },
  };
  return {
    store,
    moves,
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

describe('storage tiers', () => {
  it('does not write on the default dry-run', async () => {
    expect(parseTierArgs([]).command).toBe('dry-run');
    expect(readTierTransitionsEnabled({})).toBe(false);
    expect(readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: '' })).toBe(false);
    expect(readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: 'true' })).toBe(false);
    expect(readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: 'yes' })).toBe(false);
    expect(readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: '1 ' })).toBe(false);
    expect(readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: '1' })).toBe(true);

    for (const enabled of [false, true]) {
      const mem = memoryStore({
        'uploads/user/old.png': aged('upload', 40),
        'outputs/user/old.png': aged('output', 100),
      });
      const before = mem.snapshot();
      const report = await runStorageTiers({
        command: 'dry-run',
        enabled,
        now: NOW,
        store: mem.store,
        loadAges: async () => [],
      });
      expect(report.mode).toBe('dry-run');
      expect(report.enabled).toBe(enabled);
      expect(report.moved).toEqual([]);
      expect(report.failures).toEqual([]);
      expect(report.planned.map((item) => [item.objectKey, item.destinationKey, item.tier])).toEqual([
        ['outputs/user/old.png', 'infrequent/outputs/user/old.png', 'infrequent'],
        ['uploads/user/old.png', 'infrequent/uploads/user/old.png', 'infrequent'],
      ]);
      expect(mem.moves).toEqual([]);
      expect(mem.snapshot()).toEqual(before);
    }
  });

  it('rejects apply when STORAGE_TIER_TRANSITIONS is not 1', async () => {
    expect(parseTierArgs(['--apply']).command).toBe('apply');
    expect(() => parseTierArgs(['--purge'])).toThrow(/未知参数/);
    expect(() => parseTierArgs(['--delete'])).toThrow(/未知参数/);

    const mem = memoryStore({ 'uploads/user/old.png': aged('upload', 40) });
    const before = mem.snapshot();
    let queried = false;
    await expect(runStorageTiers({
      command: 'apply',
      enabled: false,
      now: NOW,
      store: mem.store,
      loadAges: async () => {
        queried = true;
        return [];
      },
    })).rejects.toThrow(/STORAGE_TIER_TRANSITIONS 不是 1，拒绝执行 apply，未移动任何对象/);
    expect(queried).toBe(false);
    expect(mem.listCalls()).toBe(0);
    expect(mem.moves).toEqual([]);
    expect(mem.snapshot()).toEqual(before);
  });

  it('moves a 30-day upload to infrequent', async () => {
    const mem = memoryStore({
      'uploads/user/at-30.png': aged('old', 30),
      'uploads/user/at-29.png': aged('young', 29),
    });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
    });
    expect(report.failures).toEqual([]);
    expect(report.planned).toEqual([
      {
        objectKey: 'uploads/user/at-30.png',
        destinationKey: 'infrequent/uploads/user/at-30.png',
        tier: 'infrequent',
        ageDays: 30,
      },
    ]);
    expect(report.moved).toEqual(['uploads/user/at-30.png']);
    expect(mem.snapshot()).toEqual({
      'infrequent/uploads/user/at-30.png': 'old',
      'uploads/user/at-29.png': 'young',
    });
    expect(Object.keys(mem.snapshot())).toHaveLength(2);
  });

  it('moves a 90-day upload to archive and not infrequent', async () => {
    const mem = memoryStore({
      'uploads/user/at-89.png': aged('cold', 89),
      'uploads/user/at-90.png': aged('archive-me', 90),
    });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
    });
    const archived = report.planned.filter((item) => item.objectKey === 'uploads/user/at-90.png');
    expect(archived).toEqual([
      {
        objectKey: 'uploads/user/at-90.png',
        destinationKey: 'archive/uploads/user/at-90.png',
        tier: 'archive',
        ageDays: 90,
      },
    ]);
    expect(report.failures).toEqual([]);
    expect(mem.snapshot()).toEqual({
      'archive/uploads/user/at-90.png': 'archive-me',
      'infrequent/uploads/user/at-89.png': 'cold',
    });
    expect(mem.snapshot()['infrequent/uploads/user/at-90.png']).toBeUndefined();
    expect(mem.snapshot()['uploads/user/at-90.png']).toBeUndefined();
  });

  it('moves a 90-day output to infrequent', async () => {
    const mem = memoryStore({
      'outputs/user/at-89.png': aged('young', 89),
      'outputs/user/at-90.png': aged('old', 90),
    });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
    });
    expect(report.failures).toEqual([]);
    expect(report.planned).toEqual([
      {
        objectKey: 'outputs/user/at-90.png',
        destinationKey: 'infrequent/outputs/user/at-90.png',
        tier: 'infrequent',
        ageDays: 90,
      },
    ]);
    expect(report.moved).toEqual(['outputs/user/at-90.png']);
    expect(mem.snapshot()).toEqual({
      'infrequent/outputs/user/at-90.png': 'old',
      'outputs/user/at-89.png': 'young',
    });
  });

  it('moves a 365-day output to archive', async () => {
    const mem = memoryStore({
      'outputs/user/at-364.png': aged('cold', 364),
      'outputs/user/at-365.png': aged('archive-me', 365),
    });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
    });
    expect(report.failures).toEqual([]);
    expect(report.planned).toEqual([
      {
        objectKey: 'outputs/user/at-364.png',
        destinationKey: 'infrequent/outputs/user/at-364.png',
        tier: 'infrequent',
        ageDays: 364,
      },
      {
        objectKey: 'outputs/user/at-365.png',
        destinationKey: 'archive/outputs/user/at-365.png',
        tier: 'archive',
        ageDays: 365,
      },
    ]);
    expect(mem.snapshot()).toEqual({
      'archive/outputs/user/at-365.png': 'archive-me',
      'infrequent/outputs/user/at-364.png': 'cold',
    });
    expect(mem.snapshot()['infrequent/outputs/user/at-365.png']).toBeUndefined();
  });

  it('does not move keys already under retention-hold, archive, or infrequent', async () => {
    const mem = memoryStore({
      'archive/outputs/user/old.png': aged('archived-output', 400),
      'archive/uploads/user/old.png': aged('archived-upload', 400),
      'infrequent/outputs/user/old.png': aged('cold-output', 400),
      'infrequent/uploads/user/old.png': aged('cold-upload', 400),
      'retention-hold/outputs/free/old.png': aged('held', 400),
      'uploads/user/at-30.png': aged('ready', 30),
    });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
    });
    expect(report.failures).toEqual([]);
    expect(report.moved).toEqual(['uploads/user/at-30.png']);
    expect(report.planned.map((item) => item.objectKey)).toEqual(['uploads/user/at-30.png']);
    expect(mem.snapshot()).toEqual({
      'archive/outputs/user/old.png': 'archived-output',
      'archive/uploads/user/old.png': 'archived-upload',
      'infrequent/outputs/user/old.png': 'cold-output',
      'infrequent/uploads/user/at-30.png': 'ready',
      'infrequent/uploads/user/old.png': 'cold-upload',
      'retention-hold/outputs/free/old.png': 'held',
    });
    expect(Object.keys(mem.snapshot())).toHaveLength(6);
  });

  it('does not move when the database query or the listing fails', async () => {
    const initial = { 'uploads/user/old.png': aged('pixels', 90) };
    const query: SqlQuery = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const mem = memoryStore(initial);
    const before = mem.snapshot();
    await expect(runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: () => loadTierAges(query),
    })).rejects.toThrow(/数据库查询失败，已中止，未移动任何对象: connect ECONNREFUSED/);
    expect(mem.listCalls()).toBe(0);
    expect(mem.moves).toEqual([]);
    expect(mem.snapshot()).toEqual(before);

    const listed = memoryStore({ 'outputs/user/old.png': aged('frame', 365) });
    const listedBefore = listed.snapshot();
    await expect(runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: {
        list() {
          throw new Error('EACCES');
        },
        move(fromKey, toKey) {
          listed.store.move(fromKey, toKey);
        },
      },
      loadAges: async () => [],
    })).rejects.toThrow(/对象列举失败，已中止，未移动任何对象: EACCES/);
    expect(listed.moves).toEqual([]);
    expect(listed.snapshot()).toEqual(listedBefore);
  });

  it('moves referenced and unreferenced objects without deleting either', async () => {
    const mem = memoryStore({
      'outputs/user/referenced.png': aged('ref', 1),
      'uploads/user/orphan.png': aged('orphan', 30),
      'uploads/user/undated.png': aged('undated', 90),
    });
    const createdAt = new Date(NOW - 90 * DAY_MS).toISOString();
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: () => loadTierAges(async (sql) => {
        if (sql === OUTPUT_AGES_SQL) {
          return [{ object_key: 'outputs/user/referenced.png', created_at: createdAt }];
        }
        if (sql === ASSET_AGES_SQL) {
          return [{ object_key: 'uploads/user/undated.png', created_at: null }];
        }
        if (sql === LEGACY_AGES_SQL) {
          return [{
            result_url: 'outputs/user/missing.png',
            poster_url: 'https://cdn.example/a.png',
            created_at: new Date(NOW - 400 * DAY_MS).toISOString(),
          }];
        }
        throw new Error(`unexpected ${sql}`);
      }),
    });
    expect(report.failures).toEqual([]);
    expect(report.moved.sort()).toEqual([
      'outputs/user/referenced.png',
      'uploads/user/orphan.png',
    ]);
    expect(mem.snapshot()).toEqual({
      'infrequent/outputs/user/referenced.png': 'ref',
      'infrequent/uploads/user/orphan.png': 'orphan',
      'uploads/user/undated.png': 'undated',
    });
    expect(mem.snapshot()['outputs/user/missing.png']).toBeUndefined();
    expect(Object.keys(mem.snapshot())).toHaveLength(3);
  });

  it('refuses STORAGE_DRIVER=s3', () => {
    expect(() => assertLocalStorageDriver('s3')).toThrow(/桶生命周期/);
    expect(() => assertLocalStorageDriver(' S3 ')).toThrow(/桶生命周期/);
    expect(() => assertLocalStorageDriver('local')).not.toThrow();
    expect(() => assertLocalStorageDriver(undefined)).not.toThrow();
  });

  it('does not call rewrite on dry-run', async () => {
    const mem = memoryStore({
      'uploads/user/old.png': aged('upload', 40),
      'outputs/user/old.png': aged('output', 100),
    });
    const before = mem.snapshot();
    let calls = 0;
    const report = await runStorageTiers({
      command: 'dry-run',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
      rewrite: async () => {
        calls += 1;
        throw new Error('dry-run must not rewrite');
      },
    });
    expect(calls).toBe(0);
    expect(report.mode).toBe('dry-run');
    expect(report.moved).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(mem.moves).toEqual([]);
    expect(mem.snapshot()).toEqual(before);
  });

  it('rewrites the old key to the new key after the file rename succeeds', async () => {
    const mem = memoryStore({ 'uploads/user/old.png': aged('upload', 40) });
    const calls: Array<[string, string]> = [];
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
      rewrite: async (fromKey, toKey) => {
        expect(mem.snapshot()).toEqual({ 'infrequent/uploads/user/old.png': 'upload' });
        calls.push([fromKey, toKey]);
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.moved).toEqual(['uploads/user/old.png']);
    expect(calls).toEqual([['uploads/user/old.png', 'infrequent/uploads/user/old.png']]);
    expect(mem.snapshot()).toEqual({ 'infrequent/uploads/user/old.png': 'upload' });
  });

  it('restores the file when rewrite throws and does not count the key as moved', async () => {
    const mem = memoryStore({ 'outputs/user/old.png': aged('output', 100) });
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
      rewrite: async () => {
        throw new Error('deadlock');
      },
    });
    expect(report.moved).toEqual([]);
    expect(report.failures).toEqual([{ objectKey: 'outputs/user/old.png', message: 'deadlock' }]);
    expect(mem.snapshot()).toEqual({ 'outputs/user/old.png': 'output' });
    expect(mem.moves).toEqual([
      'outputs/user/old.png -> infrequent/outputs/user/old.png',
      'infrequent/outputs/user/old.png -> outputs/user/old.png',
    ]);
  });

  it('records both failures when the file cannot be renamed back', async () => {
    const mem = memoryStore({ 'uploads/user/old.png': aged('upload', 90) });
    let moves = 0;
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: {
        list: () => mem.store.list(),
        move(fromKey, toKey) {
          moves += 1;
          if (moves > 1) throw new Error('restore EACCES');
          mem.store.move(fromKey, toKey);
        },
      },
      loadAges: async () => [],
      rewrite: async () => {
        throw new Error('tx failed');
      },
    });
    expect(report.moved).toEqual([]);
    expect(report.failures).toEqual([{
      objectKey: 'uploads/user/old.png',
      message: '两步都失败：数据库回写失败（tx failed），文件回滚失败（restore EACCES）',
    }]);
    expect(mem.snapshot()).toEqual({ 'archive/uploads/user/old.png': 'upload' });
  });

  it('moves an orphan the database does not know and still calls rewrite', async () => {
    const mem = memoryStore({ 'uploads/user/orphan.png': aged('orphan', 30) });
    const calls: Array<[string, string]> = [];
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadAges: async () => [],
      rewrite: async (fromKey, toKey) => {
        calls.push([fromKey, toKey]);
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.moved).toEqual(['uploads/user/orphan.png']);
    expect(calls).toEqual([['uploads/user/orphan.png', 'infrequent/uploads/user/orphan.png']]);
    expect(mem.snapshot()).toEqual({ 'infrequent/uploads/user/orphan.png': 'orphan' });
  });

  it('rewrites exact keys with the new key first and treats zero rows as success', async () => {
    const calls: Array<[string, [string, string]]> = [];
    await rewriteTierObjectKey(async (sql, params) => {
      calls.push([sql, params]);
      return { affectedRows: 0 };
    }, 'uploads/user/orphan.png', 'archive/uploads/user/orphan.png');
    expect(calls.map(([sql]) => sql)).toEqual([...TIER_KEY_REWRITE_SQL]);
    expect(calls).toEqual([
      ['UPDATE task_outputs SET object_key = ? WHERE object_key = ?', ['archive/uploads/user/orphan.png', 'uploads/user/orphan.png']],
      ['UPDATE assets SET url = ? WHERE url = ?', ['archive/uploads/user/orphan.png', 'uploads/user/orphan.png']],
      ['UPDATE generation_tasks SET result_url = ? WHERE result_url = ?', ['archive/uploads/user/orphan.png', 'uploads/user/orphan.png']],
      ['UPDATE generation_tasks SET poster_url = ? WHERE poster_url = ?', ['archive/uploads/user/orphan.png', 'uploads/user/orphan.png']],
    ]);
    expect(calls.some(([sql]) => sql.includes('canvas_documents') || sql.includes('LIKE') || sql.includes('REPLACE'))).toBe(false);
    expect(isTierRestore('archive/uploads/user/orphan.png', 'uploads/user/orphan.png')).toBe(true);
    expect(isTierRestore('infrequent/outputs/user/a.png', 'outputs/user/a.png')).toBe(true);
    expect(isTierRestore('uploads/user/orphan.png', 'archive/uploads/user/orphan.png')).toBe(false);
  });

  it('does not rewrite absolute paths or http urls', async () => {
    const calls: string[] = [];
    const execute = async () => {
      calls.push('called');
    };
    await expect(rewriteTierObjectKey(execute, 'https://cdn.example/a.png', 'infrequent/uploads/user/a.png'))
      .rejects.toThrow(/绝对路径或 URL/);
    await expect(rewriteTierObjectKey(execute, 'HTTP://cdn.example/a.png', 'archive/uploads/user/a.png'))
      .rejects.toThrow(/绝对路径或 URL/);
    await expect(rewriteTierObjectKey(execute, '/uploads/user/a.png', 'infrequent/uploads/user/a.png'))
      .rejects.toThrow(/绝对路径或 URL/);
    await expect(rewriteTierObjectKey(execute, 'C:\\uploads\\user\\a.png', 'archive/uploads/user/a.png'))
      .rejects.toThrow(/绝对路径或 URL/);
    await expect(rewriteTierObjectKey(execute, 'uploads/user/a.png', 'https://cdn.example/a.png'))
      .rejects.toThrow(/绝对路径或 URL/);
    expect(calls).toEqual([]);
  });

  it('does not rewrite when the rename fails', async () => {
    let called = false;
    const report = await runStorageTiers({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: {
        list: () => [{ objectKey: 'uploads/user/old.png', modifiedAtMs: NOW - 40 * DAY_MS }],
        move() {
          throw new Error('EACCES');
        },
      },
      loadAges: async () => [],
      rewrite: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    expect(report.moved).toEqual([]);
    expect(report.failures).toEqual([{ objectKey: 'uploads/user/old.png', message: 'EACCES' }]);
  });
});
