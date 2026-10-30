import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(), query: vi.fn(), queryOne: vi.fn(), withTransaction: vi.fn(),
  putObjectFromPath: vi.fn(), removeObject: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  exec: mocks.exec, query: mocks.query, queryOne: mocks.queryOne, withTransaction: mocks.withTransaction,
  pool: {},
}));
vi.mock('../src/services/storage.js', () => ({
  keys: { output: (userId: string, taskId: string, file: string) => `outputs/${userId}/${taskId}/${file}` },
  putObjectFromPath: mocks.putObjectFromPath,
  removeObject: mocks.removeObject,
  signedUrl: (key: string) => `/media/${key}`,
}));

import { persistOutputs } from '../src/services/pipeline.js';

describe('generation output finalization', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('does not resurrect a task that was cancelled while its provider was rendering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-pipeline-'));
    tempDirs.push(dir);
    const rendered = join(dir, 'rendered.png');
    writeFileSync(
      rendered,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const conn = { query: vi.fn().mockResolvedValueOnce([[{ status: 'failed' }], []]) };
    mocks.withTransaction.mockImplementation(async (fn) => fn(conn));
    mocks.queryOne.mockResolvedValue(undefined);
    mocks.putObjectFromPath.mockResolvedValue({ objectKey: 'ignored', bytes: 14 });
    mocks.removeObject.mockResolvedValue(undefined);

    const result = await persistOutputs(
      { id: 'task-1', user_id: 'user-1' } as never,
      [{ path: rendered, kind: 'image', mime: 'image/png', width: 1, height: 1, duration: null }] as never,
    );

    expect(result.persisted).toBe(false);
    expect(conn.query).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).toHaveBeenCalledWith('outputs/user-1/task-1/0-image.png');
  });

  it('stops when a cancelled task cannot take an AIGC label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-pipeline-'));
    tempDirs.push(dir);
    const rendered = join(dir, 'rendered.png');
    writeFileSync(rendered, Buffer.from('rendered-image'));
    mocks.queryOne.mockResolvedValue({ status: 'failed' });
    mocks.putObjectFromPath.mockResolvedValue({ objectKey: 'ignored', bytes: 14 });

    const result = await persistOutputs(
      { id: 'task-1', user_id: 'user-1' } as never,
      [{ path: rendered, kind: 'image', mime: 'image/png', width: 640, height: 360, duration: null }] as never,
    );

    expect(result.persisted).toBe(false);
    expect(mocks.putObjectFromPath).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });
});
