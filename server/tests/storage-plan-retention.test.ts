import { describe, expect, it } from 'vitest';
import {
  ASSET_REFERENCES_SQL,
  DAY_MS,
  LEGACY_REFERENCES_SQL,
  OUTPUT_REFERENCES_SQL,
  loadReferencedOutputs,
  parseQuarantineManifest,
  parseRetentionArgs,
  readPlanRetentionEnabled,
  runPlanRetention,
  type QuarantineRecord,
  type ReferenceRow,
  type RetentionStore,
  type SqlQuery,
} from '../src/scripts/storage-plan-retention-lib.js';

const NOW = Date.parse('2026-10-26T00:00:00.000Z');

function reference(
  objectKey: string,
  ageDays: number,
  planId: string | null,
  userId = 'user-free',
  planExpiresAt: string | null = null,
): ReferenceRow {
  return {
    objectKey,
    createdAtMs: NOW - ageDays * DAY_MS,
    planId,
    planExpiresAt,
    userId,
  };
}

function memoryStore(initial: Record<string, string>, records: QuarantineRecord[] = []) {
  const objects = new Map(Object.entries(initial));
  let manifest = records.map((record) => ({ ...record }));
  const ops: string[] = [];
  const store: RetentionStore = {
    has(key) {
      ops.push(`has ${key}`);
      return objects.has(key);
    },
    listQuarantine() {
      ops.push('list');
      return manifest.map((record) => ({ ...record }));
    },
    quarantine(record) {
      ops.push(`quarantine ${record.originalKey}`);
      const body = objects.get(record.originalKey);
      if (body === undefined) throw new Error(`missing ${record.originalKey}`);
      if (objects.has(record.quarantineKey)) throw new Error(`dest exists ${record.quarantineKey}`);
      objects.set(record.quarantineKey, body);
      objects.delete(record.originalKey);
      manifest = [...manifest, { ...record }];
    },
    restore(record) {
      ops.push(`restore ${record.originalKey}`);
      const body = objects.get(record.quarantineKey);
      if (body === undefined) throw new Error(`missing ${record.quarantineKey}`);
      if (objects.has(record.originalKey)) throw new Error(`dest exists ${record.originalKey}`);
      objects.set(record.originalKey, body);
      objects.delete(record.quarantineKey);
      manifest = manifest.filter((item) => item.originalKey !== record.originalKey);
    },
    purge(record) {
      ops.push(`purge ${record.quarantineKey}`);
      objects.delete(record.quarantineKey);
      manifest = manifest.filter((item) => item.originalKey !== record.originalKey);
    },
  };
  return {
    store,
    ops,
    snapshot() {
      return Object.fromEntries([...objects.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
  };
}

describe('storage plan retention', () => {
  it('does not write on the default dry-run', async () => {
    expect(parseRetentionArgs([]).command).toBe('dry-run');
    expect(readPlanRetentionEnabled({})).toBe(false);
    expect(readPlanRetentionEnabled({ STORAGE_PLAN_RETENTION: 'true' })).toBe(false);
    expect(readPlanRetentionEnabled({ STORAGE_PLAN_RETENTION: '1' })).toBe(true);

    for (const enabled of [false, true]) {
      const mem = memoryStore({ 'outputs/free/old.png': 'pixels' });
      const before = mem.snapshot();
      const report = await runPlanRetention({
        command: 'dry-run',
        enabled,
        now: NOW,
        store: mem.store,
        loadReferences: async () => [reference('outputs/free/old.png', 40, 'free')],
      });
      expect(report.mode).toBe('dry-run');
      expect(report.moved).toEqual([]);
      expect(report.restored).toEqual([]);
      expect(report.purged).toEqual([]);
      expect(report.candidates.map((item) => item.objectKey)).toEqual(['outputs/free/old.png']);
      expect(report.notices[0]?.message).toContain('用户通知');
      expect(report.notices[0]?.message).toContain('7');
      expect(mem.ops).toEqual([]);
      expect(mem.snapshot()).toEqual(before);
    }
  });

  it('rejects apply, restore, and purge when STORAGE_PLAN_RETENTION is not 1', async () => {
    const mem = memoryStore({ 'outputs/free/old.png': 'pixels' });
    const before = mem.snapshot();
    let queried = false;
    for (const command of ['apply', 'restore', 'purge'] as const) {
      await expect(runPlanRetention({
        command,
        enabled: false,
        now: NOW,
        store: mem.store,
        loadReferences: async () => {
          queried = true;
          return [reference('outputs/free/old.png', 40, 'free')];
        },
      })).rejects.toThrow(/STORAGE_PLAN_RETENTION 不是 1/);
    }
    expect(queried).toBe(false);
    expect(mem.ops).toEqual([]);
    expect(mem.snapshot()).toEqual(before);
  });

  it('does not select or move paid plan outputs', async () => {
    const mem = memoryStore({
      'outputs/expired/old.png': 'expired',
      'outputs/free/old.png': 'free',
      'outputs/paid/old.png': 'paid',
      'outputs/shared/old.png': 'shared',
    });
    const report = await runPlanRetention({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadReferences: async () => [
        reference('outputs/paid/old.png', 40, 'pro', 'paid-user'),
        reference('outputs/expired/old.png', 40, 'enterprise', 'expired-user', '2020-01-01 00:00:00'),
        reference('outputs/shared/old.png', 40, 'free', 'free-user'),
        reference('outputs/shared/old.png', 40, 'pro', 'paid-user'),
        reference('outputs/free/old.png', 40, 'free', 'free-user'),
      ],
    });
    expect(report.moved).toEqual(['outputs/free/old.png']);
    expect(report.excludedPaid).toEqual([
      'outputs/expired/old.png',
      'outputs/paid/old.png',
      'outputs/shared/old.png',
    ]);
    expect(mem.snapshot()).toEqual({
      'outputs/expired/old.png': 'expired',
      'outputs/paid/old.png': 'paid',
      'outputs/shared/old.png': 'shared',
      'retention-hold/outputs/free/old.png': 'free',
    });
    expect(mem.ops.some((op) => op.includes('paid') || op.includes('expired') || op.includes('shared'))).toBe(false);
  });

  it('does not select outputs younger than 30 days, uploads, or unreferenced files', async () => {
    const mem = memoryStore({
      'outputs/free/old.png': 'old',
      'outputs/free/young.png': 'young',
      'outputs/orphan/old.png': 'orphan',
      'uploads/free/old.png': 'upload',
    });
    const report = await runPlanRetention({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadReferences: async () => [
        reference('outputs/free/young.png', 29, 'free'),
        reference('outputs/free/old.png', 30, 'free'),
        reference('uploads/free/old.png', 400, 'free'),
      ],
    });
    expect(report.moved).toEqual(['outputs/free/old.png']);
    expect(report.excludedYoung).toEqual(['outputs/free/young.png']);
    expect(report.excludedOther).toEqual(['uploads/free/old.png']);
    expect(mem.snapshot()).toEqual({
      'outputs/free/young.png': 'young',
      'outputs/orphan/old.png': 'orphan',
      'retention-hold/outputs/free/old.png': 'old',
      'uploads/free/old.png': 'upload',
    });
  });

  it('does not move or delete when a reference query fails', async () => {
    const initial = {
      'outputs/free/old.png': 'live',
      'retention-hold/outputs/free/held.png': 'held',
    };
    const held: QuarantineRecord = {
      originalKey: 'outputs/free/held.png',
      quarantineKey: 'retention-hold/outputs/free/held.png',
      quarantinedAtMs: NOW - 30 * DAY_MS,
      userId: 'user-free',
    };
    const query: SqlQuery = async (sql) => {
      if (sql === OUTPUT_REFERENCES_SQL) {
        return [{
          object_key: 'outputs/free/old.png',
          created_at: '2026-01-01 00:00:00',
          user_id: 'user-free',
          plan_id: 'free',
          plan_expires_at: null,
        }];
      }
      if (sql === ASSET_REFERENCES_SQL) throw new Error('connect ECONNREFUSED');
      if (sql === LEGACY_REFERENCES_SQL) return [];
      throw new Error(`unexpected sql: ${sql}`);
    };

    for (const command of ['apply', 'purge'] as const) {
      const mem = memoryStore(initial, [held]);
      await expect(runPlanRetention({
        command,
        enabled: true,
        now: NOW,
        store: mem.store,
        loadReferences: () => loadReferencedOutputs(query),
      })).rejects.toThrow(/引用查询失败，已中止，未移动或删除任何对象: connect ECONNREFUSED/);
      expect(mem.ops).toEqual([]);
      expect(mem.snapshot()).toEqual({
        'outputs/free/old.png': 'live',
        'retention-hold/outputs/free/held.png': 'held',
      });
    }
  });

  it('restores a quarantined object inside the recovery window', async () => {
    const key = 'outputs/free/old.png';
    const mem = memoryStore({ [key]: 'pixels' });
    const loadReferences = async () => [reference(key, 45, 'free', 'user-free')];
    const applied = await runPlanRetention({
      command: 'apply',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadReferences,
    });
    expect(applied.moved).toEqual([key]);
    expect(applied.purged).toEqual([]);
    expect(mem.snapshot()).toEqual({ [`retention-hold/${key}`]: 'pixels' });

    await expect(runPlanRetention({
      command: 'restore',
      enabled: false,
      now: NOW + 6 * DAY_MS,
      store: mem.store,
      loadReferences,
    })).rejects.toThrow(/STORAGE_PLAN_RETENTION 不是 1/);
    expect(mem.snapshot()).toEqual({ [`retention-hold/${key}`]: 'pixels' });

    const earlyPurge = await runPlanRetention({
      command: 'purge',
      enabled: true,
      now: NOW + 6 * DAY_MS,
      store: mem.store,
      loadReferences,
    });
    expect(earlyPurge.purged).toEqual([]);
    expect(earlyPurge.skipped.map((item) => item.reason)).toEqual(['inside-recovery-window']);
    expect(mem.snapshot()).toEqual({ [`retention-hold/${key}`]: 'pixels' });

    const restored = await runPlanRetention({
      command: 'restore',
      enabled: true,
      now: NOW + 6 * DAY_MS,
      store: mem.store,
      loadReferences,
    });
    expect(restored.restored).toEqual([key]);
    expect(mem.snapshot()).toEqual({ [key]: 'pixels' });

    const latePurge = await runPlanRetention({
      command: 'purge',
      enabled: true,
      now: NOW + 10 * DAY_MS,
      store: mem.store,
      loadReferences,
    });
    expect(latePurge.purged).toEqual([]);
    expect(mem.snapshot()).toEqual({ [key]: 'pixels' });
  });

  it('purges only hold objects after the recovery window and never paid ones', async () => {
    const freeKey = 'outputs/free/old.png';
    const paidKey = 'outputs/paid/old.png';
    const freeHold = `retention-hold/${freeKey}`;
    const paidHold = `retention-hold/${paidKey}`;
    const quarantinedAtMs = NOW - 8 * DAY_MS;
    const mem = memoryStore(
      { [freeHold]: 'free-held', [paidHold]: 'paid-held', [paidKey]: 'paid-live' },
      [
        { originalKey: freeKey, quarantineKey: freeHold, quarantinedAtMs, userId: 'user-free' },
        { originalKey: paidKey, quarantineKey: paidHold, quarantinedAtMs, userId: 'user-paid' },
      ],
    );
    const report = await runPlanRetention({
      command: 'purge',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadReferences: async () => [
        reference(freeKey, 50, 'free', 'user-free'),
        reference(paidKey, 50, 'pro', 'user-paid'),
      ],
    });
    expect(report.purged).toEqual([freeKey]);
    expect(report.skipped).toEqual([{ objectKey: paidKey, reason: 'paid-plan' }]);
    expect(mem.snapshot()).toEqual({
      [paidHold]: 'paid-held',
      [paidKey]: 'paid-live',
    });
    expect(mem.ops.some((op) => op.startsWith('purge') && op.includes('paid'))).toBe(false);
  });

  it('refuses a manifest record that points at a live output', async () => {
    expect(() => parseQuarantineManifest(JSON.stringify({
      version: 1,
      records: [{
        originalKey: 'outputs/paid/old.png',
        quarantineKey: 'outputs/paid/old.png',
        quarantinedAtMs: NOW,
        userId: 'user-paid',
      }],
    }))).toThrow(/隔离/);

    const mem = memoryStore(
      { 'outputs/paid/old.png': 'paid' },
      [{
        originalKey: 'outputs/paid/old.png',
        quarantineKey: 'outputs/paid/old.png',
        quarantinedAtMs: NOW - 30 * DAY_MS,
        userId: 'user-paid',
      }],
    );
    const report = await runPlanRetention({
      command: 'purge',
      enabled: true,
      now: NOW,
      store: mem.store,
      loadReferences: async () => [],
    });
    expect(report.purged).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(mem.ops.filter((op) => op.startsWith('purge'))).toEqual([]);
    expect(mem.snapshot()).toEqual({ 'outputs/paid/old.png': 'paid' });
  });

  it('keeps reference queries read-only and still sees task and asset outputs', async () => {
    for (const sql of [OUTPUT_REFERENCES_SQL, ASSET_REFERENCES_SQL, LEGACY_REFERENCES_SQL]) {
      expect(sql.startsWith('SELECT ')).toBe(true);
      expect(sql).not.toMatch(/\b(DELETE|UPDATE|INSERT|DROP|ALTER)\b/i);
    }
    expect(OUTPUT_REFERENCES_SQL).toContain('task_outputs');
    expect(ASSET_REFERENCES_SQL).toContain('assets');
    expect(LEGACY_REFERENCES_SQL).toContain('generation_tasks');

    const rows = await loadReferencedOutputs(async (sql) => {
      if (sql === OUTPUT_REFERENCES_SQL) {
        return [{
          object_key: 'outputs/free/task.png',
          created_at: '2026-01-01 00:00:00',
          user_id: 'user-free',
          plan_id: 'free',
          plan_expires_at: null,
        }];
      }
      if (sql === ASSET_REFERENCES_SQL) {
        return [{
          object_key: 'outputs/free/asset.png',
          created_at: '2026-01-01 00:00:00',
          user_id: 'user-free',
          plan_id: 'free',
          plan_expires_at: null,
        }];
      }
      if (sql === LEGACY_REFERENCES_SQL) {
        return [{
          result_url: 'https://cdn.example/ignored.png',
          poster_url: 'outputs/paid/legacy.png',
          created_at: '2026-01-01 00:00:00',
          user_id: 'user-paid',
          plan_id: 'pro',
          plan_expires_at: null,
        }];
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    const selected = rows.filter((row) => row.planId === 'free').map((row) => row.objectKey).sort();
    expect(selected).toEqual(['outputs/free/asset.png', 'outputs/free/task.png']);
    expect(rows.some((row) => row.objectKey.startsWith('https://'))).toBe(false);
    expect(rows.find((row) => row.objectKey === 'outputs/paid/legacy.png')?.planId).toBe('pro');
    expect(rows.find((row) => row.objectKey === 'outputs/free/task.png')?.createdAtMs)
      .toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
