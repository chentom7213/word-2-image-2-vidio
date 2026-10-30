import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  C2PA_AI_SOURCE_TYPE,
  C2PA_CLAIM_GENERATOR,
  configuredC2paCredentials,
  contentCredentialDefinition,
} from '../src/services/c2pa-sign.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
  putObjectFromPath: vi.fn(),
  removeObject: vi.fn(),
  applyAigcLabel: vi.fn(async () => ({ watermarked: 1 as const })),
  planForUser: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  exec: mocks.exec,
  query: mocks.query,
  queryOne: mocks.queryOne,
  withTransaction: mocks.withTransaction,
  pool: {},
}));
vi.mock('../src/services/plans.js', () => ({
  planForUser: mocks.planForUser,
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

const task = { id: 'task-1', user_id: 'user-1' } as never;
const configured = { certificatePem: 'configured', privateKeyPem: 'configured' };

describe('C2PA content credentials', () => {
  const dirs: string[] = [];
  let conn: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    conn = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes('SELECT status')) return [[{ status: 'running' }]];
        return [[]];
      }),
    };
    mocks.putObjectFromPath.mockResolvedValue(undefined);
    mocks.removeObject.mockResolvedValue(undefined);
    mocks.applyAigcLabel.mockResolvedValue({ watermarked: 1 });
    mocks.planForUser.mockResolvedValue({ features: { watermark: true } });
    mocks.withTransaction.mockImplementation(async (fn: (connection: typeof conn) => Promise<unknown>) => fn(conn));
  });

  afterEach(() => {
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('treats signing as unconfigured unless both values are non-empty strings', () => {
    expect(configuredC2paCredentials(undefined, undefined)).toBeNull();
    expect(configuredC2paCredentials('', 'configured')).toBeNull();
    expect(configuredC2paCredentials('configured', '')).toBeNull();
    expect(configuredC2paCredentials('configured', 'configured')).toEqual(configured);
  });

  it('states that the asset is AI generated and names benchu-canvas', () => {
    const definition = contentCredentialDefinition('image/png');
    expect(definition.claim_generator).toBe(C2PA_CLAIM_GENERATOR);
    expect(definition.claim_generator_info).toEqual([{ name: 'benchu-canvas' }]);
    expect(definition.title).toBe('AI 生成');
    expect(definition).not.toHaveProperty('vendor');
    expect(definition.assertions[0]?.data.actions[0]).toMatchObject({
      action: 'c2pa.created',
      digitalSourceType: C2PA_AI_SOURCE_TYPE,
      softwareAgent: { name: 'benchu-canvas' },
      description: 'AI 生成',
    });
  });

  it('does not change bytes or call the signer when credentials are missing', async () => {
    const original = Buffer.from('unsigned-image');
    const imagePath = tempFile('image.png', original);
    const sign = vi.fn();

    const result = await persistOutputs(
      task,
      [output(imagePath, 'image', 'image/png', original.byteLength)],
      {
        remote: false,
        c2paCredentials: null,
        signContentCredential: sign,
        signal: AbortSignal.abort(),
      },
    );

    expect(sign).not.toHaveBeenCalled();
    expect(result.persisted).toBe(true);
    expect(result.rows[0]).toMatchObject({
      kind: 'image',
      bytes: original.byteLength,
      sha256: sha256(original),
      watermarked: 1,
    });
  });

  it('does not call the signer or change bytes for a paid plan', async () => {
    mocks.planForUser.mockResolvedValue({ features: { watermark: false } });
    mocks.applyAigcLabel.mockResolvedValue({ watermarked: 0 });
    const original = Buffer.from('paid-image');
    const imagePath = tempFile('image.png', original);
    const sign = vi.fn(async () => {
      writeFileSync(imagePath, Buffer.from('should-not-happen'));
    });

    const result = await persistOutputs(
      task,
      [output(imagePath, 'image', 'image/png', original.byteLength)],
      {
        remote: true,
        c2paCredentials: configured,
        signContentCredential: sign,
        signal: AbortSignal.abort(),
      },
    );

    expect(sign).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      watermarked: 0,
      bytes: original.byteLength,
      sha256: sha256(original),
    });
  });

  it('signs a free-plan image once and does not sign the derived thumbnail', async () => {
    const original = Buffer.from('free-image');
    const signed = Buffer.from('free-image-signed');
    const jpeg = Buffer.from('thumbnail-jpeg');
    const imagePath = tempFile('image.png', original);
    const sign = vi.fn(async ({ path }: { path: string }) => {
      expect(path).toBe(imagePath);
      writeFileSync(path, signed);
    });

    const result = await persistOutputs(
      task,
      [output(imagePath, 'image', 'image/png', original.byteLength, 640, 360)],
      { remote: false, c2paCredentials: configured, signContentCredential: sign, scaleImage: writingScale(signed, jpeg) },
    );

    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.rows.map((row) => row.kind)).toEqual(['image', 'thumbnail']);
    expect(result.rows[0]).toMatchObject({
      kind: 'image',
      watermarked: 1,
      bytes: signed.byteLength,
      sha256: sha256(signed),
    });
    expect(result.rows[1]?.kind).toBe('thumbnail');
    expect(mocks.putObjectFromPath).toHaveBeenCalledTimes(2);
  });

  it('does not record the main file as watermarked when signing throws', async () => {
    const imagePath = tempFile('image.png', Buffer.from('free-image'));
    const posterPath = tempFile('poster.png', Buffer.from('poster'));
    let calls = 0;
    const sign = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return;
      throw new Error('签名失败');
    });

    await expect(
      persistOutputs(
        task,
        [
          output(imagePath, 'image', 'image/png', 10),
          output(posterPath, 'poster', 'image/png', 6),
        ],
        { remote: false, c2paCredentials: configured, signContentCredential: sign, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow('签名失败');

    expect(sign).toHaveBeenCalledTimes(2);
    expect(mocks.putObjectFromPath).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).toHaveBeenCalledWith('outputs/user-1/task-1/0-image.png');
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(insertedWatermarkFlags(conn)).toEqual([]);
  });

  function tempFile(name: string, bytes: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), 'benchu-c2pa-'));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }
});

function output(
  path: string,
  kind: 'image' | 'poster' | 'video',
  mime: string,
  bytes: number,
  width = 32,
  height = 32,
) {
  return { path, kind, mime, width, height, duration: 0, bytes };
}

function writingScale(signed: Buffer, jpeg: Buffer) {
  return vi.fn(async ({ sourcePath, destPath }: { sourcePath: string; destPath: string }) => {
    expect(readFileSync(sourcePath).equals(signed)).toBe(true);
    writeFileSync(destPath, jpeg);
  });
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function insertedWatermarkFlags(conn: { query: ReturnType<typeof vi.fn> }) {
  return conn.query.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO task_outputs'))
    .map((args) => (args[1] as unknown[])[10]);
}
