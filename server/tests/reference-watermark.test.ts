import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { discardRenderTemp, isolateUploadedOutput, localUploadRoot } from '../src/services/output-source.js';

/** 1×1 PNG. Tests never spawn ffmpeg and never open a database. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const symlinkProbe = probeSymlink();

describe('reference images stay outside the watermark path', () => {
  const dirs: string[] = [];
  const copies: string[] = [];

  afterEach(() => {
    copies.splice(0).forEach((file) => rmSync(file, { force: true }));
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('uses the same upload root as the asset routes', () => {
    expect(localUploadRoot()).toBe(resolve(process.cwd(), env.uploadDir));
  });

  it('copies an uploaded reference and leaves its bytes untouched', () => {
    const { uploadRoot } = createFixture(dirs);
    const original = join(uploadRoot, 'ref.png');
    writeFileSync(original, TINY_PNG);
    const before = readFileSync(original);

    const result = isolateUploadedOutput(original, uploadRoot);
    copies.push(result);

    expect(readFileSync(original)).toEqual(before);
    expect(readFileSync(result)).toEqual(before);
    expect(result).not.toBe(original);
    expect(residesInUploadRoot(uploadRoot, result)).toBe(false);
    expect(basename(dirname(result))).toBe('benchu-render');
    expect(basename(result)).toMatch(/^[0-9a-f-]{36}\.png$/i);
    expect(lstatSync(result).isSymbolicLink()).toBe(false);
  });

  it('does not delete an uploaded reference when a render temp is discarded', () => {
    const { root, uploadRoot } = createFixture(dirs);
    const original = join(uploadRoot, 'ref.png');
    writeFileSync(original, TINY_PNG);
    const tempFile = join(root, 'render.png');
    writeFileSync(tempFile, TINY_PNG);

    discardRenderTemp(original, uploadRoot);
    discardRenderTemp(tempFile, uploadRoot);

    expect(readFileSync(original)).toEqual(TINY_PNG);
    expect(() => readFileSync(tempFile)).toThrow();
  });

  it('returns a normal temporary file unchanged', () => {
    const { root, uploadRoot } = createFixture(dirs);
    const tempFile = join(root, 'render.png');
    writeFileSync(tempFile, TINY_PNG);

    const result = isolateUploadedOutput(tempFile, uploadRoot);

    expect(result).toBe(tempFile);
    expect(readFileSync(tempFile)).toEqual(TINY_PNG);
  });

  it.skipIf(!symlinkProbe.ok)('copies a symlink that resolves inside the upload root', () => {
    const { root, uploadRoot } = createFixture(dirs);
    const original = join(uploadRoot, 'ref.png');
    writeFileSync(original, TINY_PNG);
    const before = readFileSync(original);
    const link = join(root, 'link.png');
    symlinkSync(original, link);

    const result = isolateUploadedOutput(link, uploadRoot);
    copies.push(result);

    expect(result).not.toBe(link);
    expect(realpathSync(result)).not.toBe(realpathSync(link));
    expect(lstatSync(result).isSymbolicLink()).toBe(false);
    expect(residesInUploadRoot(uploadRoot, result)).toBe(false);
    expect(readFileSync(original)).toEqual(before);
    expect(readFileSync(result)).toEqual(before);
  });
});

function createFixture(dirs: string[]): { root: string; uploadRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'benchu-ref-watermark-'));
  dirs.push(root);
  const uploadRoot = join(root, 'uploads');
  mkdirSync(uploadRoot);
  return { root, uploadRoot };
}

function probeSymlink(): { ok: boolean; code?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'benchu-symlink-probe-'));
  try {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'link.txt'));
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : 'unknown';
    // Windows blocks unprivileged symlink creation. Other failures should surface.
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, code };
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function residesInUploadRoot(uploadRoot: string, filePath: string): boolean {
  const root = realpathSync(uploadRoot);
  const file = realpathSync(filePath);
  const rel = relative(root, file);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[/\\]/).includes('..');
}
