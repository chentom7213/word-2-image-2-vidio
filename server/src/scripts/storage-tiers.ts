import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pool, query, withTransaction } from '../db/pool.js';
import { localRoot } from '../services/storage/local.js';
import {
  assertLocalStorageDriver,
  assertTierRelocation,
  isHotObjectKey,
  isTierRestore,
  loadTierAges,
  parseTierArgs,
  readTierTransitionsEnabled,
  rewriteTierObjectKey,
  runStorageTiers,
  type ListedObject,
  type TierReport,
  type TierStore,
} from './storage-tiers-lib.js';

const USAGE = `用法: npm run storage:tiers -- [--apply] [--json]

默认 dry-run，且 STORAGE_TIER_TRANSITIONS 默认关闭（只有精确为 1 才打开）。
只报告会移动哪些键，不改名、不回写、不删除。

uploads/ 满 30 天进入 infrequent/uploads/，满 90 天进入 archive/uploads/。
outputs/ 满 90 天进入 infrequent/outputs/，满 365 天进入 archive/outputs/。
更长的期限覆盖更短的，一个对象只进入一个目标。
已经在 infrequent/、archive/、retention-hold/ 里的键不会再搬。

--apply  把候选对象改名到目标前缀，再在一个事务里把数据库中完全相同的对象键改成新键。
         这是移动，不是删除。回写失败会回滚事务，并把文件改回原键。
         数据库里没有这个键时，文件仍然移动。
         STORAGE_TIER_TRANSITIONS 不是 1 时失败退出，且不改名、不回写。

付费或免费、有没有引用，都不会被删除。本命令没有任何删除。
不改 storage:lifecycle 的孤儿清理，也不改 storage:plan-retention 的套餐隔离。
数据库查询或对象列举失败时失败退出，不移动。
STORAGE_DRIVER=s3 时拒绝执行，请改用桶生命周期规则。`;

function assertSafeRoot(root: string): string {
  const abs = resolve(root);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error(`拒绝扫描符号链接根目录: ${abs}`);
  const canonical = existsSync(abs) ? realpathSync(abs) : abs;
  if (canonical === parse(canonical).root) throw new Error(`拒绝扫描文件系统根目录: ${canonical}`);
  return canonical;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Refuse a path that leaves the storage root, including through a symlink. */
function assertNoSymlink(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`对象键越出存储根目录: ${path}`);
  }
  let cursor = root;
  for (const part of rel.split(sep)) {
    if (part === '' || part === '.' || part === '..') throw new Error(`拒绝不安全路径: ${path}`);
    cursor = join(cursor, part);
    if (isSymlink(cursor)) throw new Error(`拒绝符号链接: ${cursor}`);
  }
}

function objectPath(root: string, objectKey: string): string {
  const abs = resolve(root, ...objectKey.split('/'));
  if (!inside(root, abs)) throw new Error(`对象键越出存储根目录: ${objectKey}`);
  return abs;
}

/**
 * Local prefix store. The only mutation is rename into infrequent/ or archive/,
 * or rename back to the original key when a database rewrite fails.
 * Live objects are never passed to a delete.
 */
export function createFilesystemTierStore(storageRoot: string): TierStore {
  const root = assertSafeRoot(storageRoot);

  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`拒绝扫描符号链接: ${dir}`);
    if (!stat.isDirectory()) throw new Error(`拒绝扫描非目录: ${dir}`);
    const pending = [dir];
    const files: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (!inside(root, path)) throw new Error(`对象路径越出存储根目录: ${path}`);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    return files;
  }

  return {
    list(): ListedObject[] {
      const objects: ListedObject[] = [];
      for (const prefix of ['uploads', 'outputs']) {
        for (const path of walk(join(root, prefix))) {
          const objectKey = relative(root, path).split(sep).join('/');
          if (!isHotObjectKey(objectKey)) continue;
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          objects.push({ objectKey, modifiedAtMs: stat.mtimeMs });
        }
      }
      return objects;
    },
    move(fromKey, toKey) {
      if (!isTierRestore(fromKey, toKey)) assertTierRelocation(fromKey, toKey);
      const from = objectPath(root, fromKey);
      const to = objectPath(root, toKey);
      assertNoSymlink(root, from);
      assertNoSymlink(root, dirname(to));
      const source = lstatSync(from);
      if (source.isSymbolicLink() || !source.isFile()) throw new Error('拒绝移动符号链接或非普通文件');
      if (pathExists(to)) throw new Error('目标已存在，拒绝覆盖');
      mkdirSync(dirname(to), { recursive: true });
      assertNoSymlink(root, to);
      renameSync(from, to);
    },
  };
}

function printReport(report: TierReport): void {
  console.log(`本地冷热搬迁 · ${report.mode}`);
  console.log(report.enabled
    ? 'STORAGE_TIER_TRANSITIONS=1。'
    : 'STORAGE_TIER_TRANSITIONS 不是 1，默认关闭。');
  console.log('uploads/ 满 30 天进入 infrequent/uploads/，满 90 天进入 archive/uploads/。');
  console.log('outputs/ 满 90 天进入 infrequent/outputs/，满 365 天进入 archive/outputs/。');
  console.log(`候选 ${report.planned.length} 个。`);
  if (report.mode === 'dry-run') {
    console.log('未移动任何对象。本命令不删除对象。确认后设置 STORAGE_TIER_TRANSITIONS=1 再执行 --apply。');
  } else {
    console.log(`已移动 ${report.moved.length} 个，并回写数据库中的相同对象键。未删除任何对象。`);
  }
  for (const item of report.planned.slice(0, 50)) {
    console.log(`  ${item.objectKey}  →  ${item.destinationKey}  （${item.ageDays} 天）`);
  }
  if (report.planned.length > 50) console.log(`  … 另有 ${report.planned.length - 50} 个候选，请用 --json 查看`);
  for (const item of report.failures) console.log(`  失败  ${item.objectKey}  ${item.message}`);
}

function runQuery<T>(sql: string): Promise<T[]> {
  return query<T>(sql);
}

/** One pool transaction per moved key. Parameters are the new key, then the old key. */
async function rewriteMovedObjectKey(fromKey: string, toKey: string): Promise<void> {
  await withTransaction(async (conn) => {
    await rewriteTierObjectKey(async (sql, params) => {
      await conn.query(sql, [params[0], params[1]]);
    }, fromKey, toKey);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseTierArgs(argv);
  const enabled = readTierTransitionsEnabled({ STORAGE_TIER_TRANSITIONS: process.env.STORAGE_TIER_TRANSITIONS });
  assertLocalStorageDriver(process.env.STORAGE_DRIVER);
  if (args.command === 'apply' && !enabled) {
    throw new Error('STORAGE_TIER_TRANSITIONS 不是 1，拒绝执行 apply，未移动任何对象');
  }
  const store = createFilesystemTierStore(localRoot);
  const report = await runStorageTiers({
    command: args.command,
    enabled,
    now: Date.now(),
    store,
    loadAges: () => loadTierAges(runQuery),
    rewrite: rewriteMovedObjectKey,
  });
  if (args.json) console.log(JSON.stringify(report));
  else printReport(report);
  if (report.failures.length > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`本地冷热搬迁失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
