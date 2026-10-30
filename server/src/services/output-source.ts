import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { env } from '../env.js';

/** Same rule as `uploadRoot` in routes/assets.ts. */
export function localUploadRoot(): string {
  return resolve(process.cwd(), env.uploadDir);
}

/**
 * Copy an output that resolves inside the local upload root to
 * `tmpdir/benchu-render`. Ordinary render files keep their path.
 * A copy failure throws and never falls back to the upload path.
 */
export function isolateUploadedOutput(filePath: string, uploadRoot = localUploadRoot()): string {
  if (!isInsideUploadRoot(filePath, uploadRoot)) return filePath;

  const source = realpathSync(filePath);
  const dir = join(tmpdir(), 'benchu-render');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}${extname(source) || extname(filePath)}`);
  try {
    copyFileSync(source, dest);
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
  if (isInsideUploadRoot(dest, uploadRoot)) {
    rmSync(dest, { force: true });
    throw new Error('产物副本仍落在上传目录中');
  }
  return dest;
}

/** Deletes a render temp file. A path inside the upload root is left in place. */
export function discardRenderTemp(filePath: string, uploadRoot = localUploadRoot()): void {
  if (isInsideUploadRoot(filePath, uploadRoot)) return;
  rmSync(filePath, { force: true });
}

/** True when `filePath` or its symlink target lies in the upload root. */
export function isInsideUploadRoot(filePath: string, uploadRoot = localUploadRoot()): boolean {
  const lexicalRoot = resolve(uploadRoot);
  const lexicalFile = resolve(filePath);
  if (pathIsInside(lexicalRoot, lexicalFile)) return true;

  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(uploadRoot);
  } catch {
    return false;
  }
  if (pathIsInside(physicalRoot, lexicalFile)) return true;

  try {
    const physicalFile = realpathSync(filePath);
    return pathIsInside(physicalRoot, physicalFile) || pathIsInside(lexicalRoot, physicalFile);
  } catch {
    return false;
  }
}

function pathIsInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[/\\]/).includes('..');
}
