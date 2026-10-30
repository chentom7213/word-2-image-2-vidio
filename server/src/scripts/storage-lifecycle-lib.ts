import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export type LifecycleCandidate = {
  path: string;
  root: string;
  objectKey: string | null;
  source: 'storage' | 'temp';
  reason: 'unreferenced' | 'stale-temp';
  bytes: number;
  mtimeMs: number;
};

export type LifecycleScan = {
  candidates: LifecycleCandidate[];
  referencedFiles: number;
  youngFiles: number;
  symlinksSkipped: number;
  filesScanned: number;
  bytesReclaimable: number;
};

function assertSafeRoot(root: string): string {
  const abs = resolve(root);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error(`拒绝扫描符号链接根目录: ${abs}`);
  const canonical = existsSync(abs) ? realpathSync(abs) : abs;
  if (canonical === parse(canonical).root) throw new Error(`拒绝扫描文件系统根目录: ${canonical}`);
  return canonical;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function walk(root: string): { files: string[]; symlinks: number } {
  const safeRoot = assertSafeRoot(root);
  if (!existsSync(safeRoot)) return { files: [], symlinks: 0 };
  const pending = [safeRoot];
  const files: string[] = [];
  let symlinks = 0;
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) symlinks++;
      else if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return { files, symlinks };
}

function objectKey(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export function collectLifecycleCandidates(options: {
  storageRoot: string;
  tempRoots?: string[];
  referencedKeys: ReadonlySet<string>;
  minAgeMs: number;
  now?: number;
}): LifecycleScan {
  const storageRoot = assertSafeRoot(options.storageRoot);
  const now = options.now ?? Date.now();
  const candidates: LifecycleCandidate[] = [];
  let referencedFiles = 0;
  let youngFiles = 0;
  let symlinksSkipped = 0;
  let filesScanned = 0;

  // Only application-owned prefixes are eligible, even if OUTPUT_DIR is broad.
  for (const prefix of ['uploads', 'outputs']) {
    const root = join(storageRoot, prefix);
    const walked = walk(root);
    symlinksSkipped += walked.symlinks;
    for (const path of walked.files) {
      filesScanned++;
      const stat = statSync(path);
      const key = objectKey(storageRoot, path);
      if (options.referencedKeys.has(key)) {
        referencedFiles++;
        continue;
      }
      if (now - stat.mtimeMs < options.minAgeMs) {
        youngFiles++;
        continue;
      }
      candidates.push({ path, root, objectKey: key, source: 'storage', reason: 'unreferenced', bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  for (const rawRoot of options.tempRoots ?? []) {
    const root = assertSafeRoot(rawRoot);
    const walked = walk(root);
    symlinksSkipped += walked.symlinks;
    for (const path of walked.files) {
      filesScanned++;
      const stat = statSync(path);
      if (now - stat.mtimeMs < options.minAgeMs) {
        youngFiles++;
        continue;
      }
      candidates.push({ path, root, objectKey: null, source: 'temp', reason: 'stale-temp', bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  return { candidates, referencedFiles, youngFiles, symlinksSkipped, filesScanned, bytesReclaimable: candidates.reduce((sum, item) => sum + item.bytes, 0) };
}

export function deleteLifecycleCandidates(candidates: LifecycleCandidate[]): {
  deleted: number;
  bytesDeleted: number;
  failures: { path: string; message: string }[];
} {
  let deleted = 0;
  let bytesDeleted = 0;
  const failures: { path: string; message: string }[] = [];
  for (const candidate of candidates) {
    try {
      const root = assertSafeRoot(candidate.root);
      const path = resolve(candidate.path);
      if (!inside(root, path)) throw new Error('候选路径越出扫描根目录');
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) throw new Error('拒绝删除符号链接');
      rmSync(path, { force: true });
      deleted++;
      bytesDeleted += candidate.bytes;
    } catch (error) {
      failures.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, bytesDeleted, failures };
}
