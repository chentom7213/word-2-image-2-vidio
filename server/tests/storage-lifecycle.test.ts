import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectLifecycleCandidates, deleteLifecycleCandidates } from '../src/scripts/storage-lifecycle-lib.js';

describe('local storage lifecycle', () => {
  const roots: string[] = [];
  const now = Date.parse('2026-10-25T00:00:00Z');

  function root() {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-lifecycle-'));
    roots.push(dir);
    return dir;
  }

  function file(path: string, ageHours: number) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.from('data'));
    const time = new Date(now - ageHours * 60 * 60 * 1000);
    utimesSync(path, time, time);
  }

  afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('only selects old unreferenced objects and stale temp files', () => {
    const storage = root();
    const temp = root();
    const referenced = join(storage, 'outputs', 'u1', 'kept.png');
    const orphan = join(storage, 'outputs', 'u1', 'orphan.png');
    const young = join(storage, 'uploads', 'u1', 'uploading.png');
    const staleTemp = join(temp, 'stale-frame.png');
    file(referenced, 72);
    file(orphan, 72);
    file(young, 1);
    file(staleTemp, 72);

    const scan = collectLifecycleCandidates({
      storageRoot: storage,
      tempRoots: [temp],
      referencedKeys: new Set(['outputs/u1/kept.png']),
      minAgeMs: 24 * 60 * 60 * 1000,
      now,
    });

    expect(scan.candidates.map((item) => item.path).sort()).toEqual([orphan, staleTemp].sort());
    expect(scan.referencedFiles).toBe(1);
    expect(scan.youngFiles).toBe(1);
    expect(scan.bytesReclaimable).toBe(8);
  });

  it('deletes only the explicit candidate list', () => {
    const storage = root();
    const orphan = join(storage, 'outputs', 'u1', 'orphan.png');
    const kept = join(storage, 'outputs', 'u1', 'kept.png');
    file(orphan, 72);
    file(kept, 72);
    const scan = collectLifecycleCandidates({
      storageRoot: storage,
      referencedKeys: new Set(['outputs/u1/kept.png']),
      minAgeMs: 24 * 60 * 60 * 1000,
      now,
    });

    const result = deleteLifecycleCandidates(scan.candidates);
    expect(result).toMatchObject({ deleted: 1, bytesDeleted: 4, failures: [] });
    expect(() => statSync(orphan)).toThrow();
    expect(statSync(kept).isFile()).toBe(true);
  });
});
