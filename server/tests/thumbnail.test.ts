import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  putObjectFromPath: vi.fn(),
  removeObject: vi.fn(),
  applyAigcLabel: vi.fn(async () => ({ watermarked: 1 as const })),
}));

vi.mock('../src/db/pool.js', () => ({
  exec: mocks.exec,
  query: mocks.query,
  queryOne: mocks.queryOne,
  withTransaction: mocks.withTransaction,
  pool: {},
}));
vi.mock('../src/services/aigc-label.js', () => ({
  AigcLabelError: class AigcLabelError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AigcLabelError';
    }
  },
  applyAigcLabel: mocks.applyAigcLabel,
  planWatermarkRequired: (features: unknown) =>
    Boolean(features && typeof features === 'object' && (features as { watermark?: unknown }).watermark === true),
}));
vi.mock('../src/services/storage.js', () => ({
  keys: {
    output: (userId: string, taskId: string, file: string) => `outputs/${userId}/${taskId}/${file}`,
  },
  putObjectFromPath: mocks.putObjectFromPath,
  removeObject: mocks.removeObject,
  signedUrl: (key: string) => `/media/${key}`,
}));

import { persistOutputs } from '../src/services/pipeline.js';
import { buildThumbnailFfmpegArgs, fitThumbnailEdge } from '../src/services/thumbnail.js';

const task = { id: 'task-1', user_id: 'user-1' } as never;

describe('output thumbnails', () => {
  const dirs: string[] = [];
  let conn: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    conn = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('SELECT status')) return [[{ status: 'running' }]];
        return [[]];
      }),
    };
    mocks.queryOne.mockResolvedValue(null);
    mocks.putObjectFromPath.mockResolvedValue(undefined);
    mocks.removeObject.mockResolvedValue(undefined);
    mocks.applyAigcLabel.mockResolvedValue({ watermarked: 1 });
    mocks.withTransaction.mockImplementation(async (fn: (connection: typeof conn) => Promise<unknown>) => fn(conn));
  });

  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('fits the long edge to 320 and tells ffmpeg not to enlarge', () => {
    expect(fitThumbnailEdge(640, 360)).toEqual({ width: 320, height: 180 });
    expect(fitThumbnailEdge(100, 400)).toEqual({ width: 80, height: 320 });
    expect(fitThumbnailEdge(180, 320)).toEqual({ width: 180, height: 320 });
    expect(fitThumbnailEdge(320, 200)).toEqual({ width: 320, height: 200 });
    expect(fitThumbnailEdge(null, 100)).toBeNull();

    const fitted = buildThumbnailFfmpegArgs('source.png', 'thumb.jpg', 320, 180);
    expect(fitted).toContain('scale=320:180');
    expect(fitted.at(-1)).toBe('thumb.jpg');
    expect(fitted.join(' ')).not.toContain('force_original_aspect_ratio=increase');

    const unknown = buildThumbnailFfmpegArgs('source.png', 'thumb.jpg', 0, 0);
    expect(unknown.join(' ')).toContain('scale=320:320:force_original_aspect_ratio=decrease');
    expect(unknown.at(-1)).toBe('thumb.jpg');
  });

  it('stores a jpeg thumbnail for an image and leaves result_url on the original', async () => {
    const original = Buffer.from('original-image-bytes');
    const jpeg = Buffer.from('thumbnail-jpeg');
    const imagePath = tempFile('image.png', original);
    const scaleImage = writingScale(original, jpeg);

    const result = await persistOutputs(
      task,
      [{ path: imagePath, kind: 'image', mime: 'image/png', width: 640, height: 360, duration: 0, bytes: original.byteLength }],
      { remote: false, scaleImage },
    );

    expect(result.persisted).toBe(true);
    expect(result.rows.map((row) => row.kind)).toEqual(['image', 'thumbnail']);
    expect(result.rows[0]).toMatchObject({
      object_key: 'outputs/user-1/task-1/0-image.png',
      mime: 'image/png',
      bytes: original.byteLength,
      sha256: sha256(original),
      watermarked: 1,
      width: 640,
      height: 360,
    });
    expect(result.rows[1]).toMatchObject({
      object_key: 'outputs/user-1/task-1/1-thumbnail.jpg',
      mime: 'image/jpeg',
      width: 320,
      height: 180,
      duration: null,
      bytes: jpeg.byteLength,
      sha256: sha256(jpeg),
      watermarked: 1,
    });
    expect(scaleImage).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: imagePath, width: 320, height: 180 }),
    );
    expect(mocks.applyAigcLabel).toHaveBeenCalledTimes(1);
    expect(mocks.applyAigcLabel.mock.calls[0]?.[0]).toMatchObject({ path: imagePath });
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(insertedKinds(conn)).toEqual(['image', 'thumbnail']);
    expect(resultUrls(conn)).toEqual(['outputs/user-1/task-1/0-image.png', null, 'task-1']);
  });

  it('stores a thumbnail for a poster and does not thumbnail the video', async () => {
    const videoPath = tempFile('clip.mp4', Buffer.from('video'));
    const posterPath = tempFile('poster.png', Buffer.from('poster'));
    const scaleImage = writingScale(Buffer.from('poster'), Buffer.from('poster-thumb'));

    const result = await persistOutputs(
      task,
      [
        { path: videoPath, kind: 'video', mime: 'video/mp4', width: 1280, height: 720, duration: 5, bytes: 5 },
        { path: posterPath, kind: 'poster', mime: 'image/png', width: 900, height: 1600, duration: 0, bytes: 6 },
      ],
      { remote: true, scaleImage },
    );

    expect(result.persisted).toBe(true);
    expect(result.rows.map((row) => row.kind)).toEqual(['video', 'poster', 'thumbnail']);
    expect(result.rows[2]).toMatchObject({
      object_key: 'outputs/user-1/task-1/2-thumbnail.jpg',
      mime: 'image/jpeg',
      width: 180,
      height: 320,
      watermarked: 1,
    });
    expect(scaleImage).toHaveBeenCalledTimes(1);
    expect(scaleImage).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: posterPath, width: 180, height: 320 }));
    expect(mocks.applyAigcLabel).toHaveBeenCalledTimes(2);
    expect(resultUrls(conn)).toEqual([
      'outputs/user-1/task-1/0-video.mp4',
      'outputs/user-1/task-1/1-poster.png',
      'task-1',
    ]);
  });

  it('keeps the uploaded image when thumbnail scaling throws', async () => {
    const imagePath = tempFile('image.png', Buffer.from('original-image-bytes'));
    const scaleImage = vi.fn(async () => {
      throw new Error('无法启动 ffmpeg：spawn ffmpeg ENOENT');
    });

    const result = await persistOutputs(
      task,
      [{ path: imagePath, kind: 'image', mime: 'image/png', width: 640, height: 360, duration: 0, bytes: 20 }],
      { remote: false, scaleImage },
    );

    expect(result.persisted).toBe(true);
    expect(result.rows.map((row) => row.kind)).toEqual(['image']);
    expect(result.rows[0]?.object_key).toBe('outputs/user-1/task-1/0-image.png');
    expect(insertedKinds(conn)).toEqual(['image']);
    expect(mocks.putObjectFromPath).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(resultUrls(conn)).toEqual(['outputs/user-1/task-1/0-image.png', null, 'task-1']);
  });

  it('does not scale when the cancel signal is already aborted', async () => {
    const imagePath = tempFile('image.png', Buffer.from('original-image-bytes'));
    const scaleImage = vi.fn();
    const signal = new AbortController();
    signal.abort();

    const result = await persistOutputs(
      task,
      [{ path: imagePath, kind: 'image', mime: 'image/png', width: 640, height: 360, duration: 0, bytes: 20 }],
      { remote: false, scaleImage, signal: signal.signal },
    );

    expect(result.persisted).toBe(true);
    expect(result.rows.map((row) => row.kind)).toEqual(['image']);
    expect(scaleImage).not.toHaveBeenCalled();
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  function tempFile(name: string, bytes: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-thumb-'));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }
});

function writingScale(original: Buffer, jpeg: Buffer) {
  return vi.fn(async ({ sourcePath, destPath }: { sourcePath: string; destPath: string }) => {
    expect(readFileSync(sourcePath).equals(original)).toBe(true);
    writeFileSync(destPath, jpeg);
    expect(readFileSync(sourcePath).equals(original)).toBe(true);
  });
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function insertedKinds(conn: { query: ReturnType<typeof vi.fn> }) {
  return conn.query.mock.calls
    .filter((call) => String(call[0]).includes('INSERT INTO task_outputs'))
    .map((call) => (call[1] as unknown[])[2]);
}

function resultUrls(conn: { query: ReturnType<typeof vi.fn> }) {
  const update = conn.query.mock.calls.find((call) => String(call[0]).includes('result_url'));
  return update?.[1] as unknown[];
}
