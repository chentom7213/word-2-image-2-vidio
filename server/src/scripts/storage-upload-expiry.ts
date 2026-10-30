import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pool, query, withTransaction } from '../db/pool.js';
import { localRoot } from '../services/storage/local.js';
import {
  assertLocalStorageDriver,
  isEligibleUploadKey,
  isFixedDetachSql,
  loadUploadAges,
  parseUploadExpiryArgs,
  readUploadExpiryEnabled,
  runUploadExpiry,
  type ListedUpload,
  type UploadExpiryReport,
  type UploadExpiryStore,
} from './storage-upload-expiry-lib.js';

const USAGE = `用法: npm run storage:upload-expiry -- [--apply] [--json]

默认 dry-run，且 STORAGE_UPLOAD_EXPIRY 默认关闭（只有精确为 1 才打开）。
只报告哪些上传物已满 365 天，不删除文件，不改数据库。

只处理这三类键：
  uploads/
  infrequent/uploads/
  archive/uploads/
满 365 天才入选。仍被引用的上传也会删除，不按套餐区分。
outputs/、infrequent/outputs/、archive/outputs/、retention-hold/ 不归本命令管。

年龄优先用 assets.url、task_outputs.object_key、generation_tasks.result_url、
poster_url 上最早的 created_at。键在库里但时间解析不了则跳过。
库里没有这个键时用文件 mtime。

--apply  对每个候选先做一次事务，成功后才删除文件。
         STORAGE_UPLOAD_EXPIRY 不是 1 时失败退出，不删除、不改数据库。
         事务失败则不删该文件。文件删除失败记入 failures，退出码 2，并继续其余候选。

不修改画布 JSON。assets 删除后 generation_refs 由外键级联，本命令不再写一条 DELETE。
数据库查询或目录列举失败时整次中止，不删除。
拒绝绝对路径、.. 、URL scheme 和符号链接。
STORAGE_DRIVER=s3 时拒绝执行，请改用桶生命周期规则。`;

function assertSafeRoot(root: string): string {
  const abs = resolve(root);
  try {
    if (lstatSync(abs).isSymbolicLink()) throw new Error(`拒绝扫描符号链接根目录: ${abs}`);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const canonical = exists(abs) && !isSymlink(abs) ? realpathSync(abs) : abs;
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

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: string }).code === 'ENOENT';
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
  if (!isEligibleUploadKey(objectKey)) throw new Error(`拒绝删除非上传对象: ${objectKey}`);
  const abs = resolve(root, ...objectKey.split('/'));
  if (!inside(root, abs)) throw new Error(`对象键越出存储根目录: ${objectKey}`);
  return abs;
}

/**
 * Local upload store. Listing only walks the three upload prefixes.
 * `outputs/` and `retention-hold/` are never visited. The only mutation is
 * deleting one ordinary file after the caller has committed its transaction.
 */
export function createFilesystemUploadExpiryStore(storageRoot: string): UploadExpiryStore {
  const root = assertSafeRoot(storageRoot);
  const scanRoots = [
    join(root, 'uploads'),
    join(root, 'infrequent', 'uploads'),
    join(root, 'archive', 'uploads'),
  ];

  function walk(dir: string): string[] {
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
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
        if (entry.isSymbolicLink() || isSymlink(path)) continue;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) files.push(path);
      }
    }
    return files;
  }

  return {
    list(): ListedUpload[] {
      const objects: ListedUpload[] = [];
      for (const dir of scanRoots) {
        for (const path of walk(dir)) {
          const objectKey = relative(root, path).split(sep).join('/');
          if (!isEligibleUploadKey(objectKey)) continue;
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          objects.push({ objectKey, modifiedAtMs: stat.mtimeMs });
        }
      }
      return objects;
    },
    remove(objectKey) {
      if (!isEligibleUploadKey(objectKey)) throw new Error(`拒绝删除非上传对象: ${objectKey}`);
      const target = objectPath(root, objectKey);
      assertNoSymlink(root, target);
      let stat;
      try {
        stat = lstatSync(target);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('拒绝删除符号链接');
      if (!stat.isFile()) throw new Error('拒绝删除非普通文件');
      rmSync(target);
    },
  };
}

function printReport(report: UploadExpiryReport): void {
  console.log(`上传物满 365 天删除 · ${report.mode}`);
  console.log(report.enabled
    ? 'STORAGE_UPLOAD_EXPIRY=1。'
    : 'STORAGE_UPLOAD_EXPIRY 不是 1，默认关闭。');
  console.log('只处理 uploads/、infrequent/uploads/、archive/uploads/。outputs/ 与 retention-hold/ 不删除。');
  console.log(`候选 ${report.planned.length} 个。`);
  if (report.mode === 'dry-run') {
    console.log('未删除任何文件，未修改数据库。确认后设置 STORAGE_UPLOAD_EXPIRY=1 再执行 --apply。');
  } else {
    console.log(`已删除 ${report.deleted.length} 个。失败 ${report.failures.length} 个。`);
  }
  for (const item of report.planned.slice(0, 50)) {
    console.log(`  ${item.objectKey}  （${item.ageDays} 天，${item.ageSource === 'database' ? '数据库时间' : '文件时间'}）`);
  }
  if (report.planned.length > 50) console.log(`  … 另有 ${report.planned.length - 50} 个候选，请用 --json 查看`);
  for (const item of report.failures) console.log(`  失败  ${item.phase}  ${item.objectKey}  ${item.message}`);
}

function runQuery<T>(sql: string): Promise<T[]> {
  return query<T>(sql);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseUploadExpiryArgs(argv);
  const enabled = readUploadExpiryEnabled({ STORAGE_UPLOAD_EXPIRY: process.env.STORAGE_UPLOAD_EXPIRY });
  assertLocalStorageDriver(process.env.STORAGE_DRIVER);
  if (args.command === 'apply' && !enabled) {
    throw new Error('STORAGE_UPLOAD_EXPIRY 不是 1，拒绝执行 apply，未删除任何文件，未修改数据库');
  }
  const store = createFilesystemUploadExpiryStore(localRoot);
  const report = await runUploadExpiry({
    command: args.command,
    enabled,
    driver: process.env.STORAGE_DRIVER,
    now: Date.now(),
    store,
    loadAges: () => loadUploadAges(runQuery),
    transaction: (fn) => withTransaction(async (conn) => {
      await fn({
        execute(sql, params) {
          const key = params[0];
          if (!isFixedDetachSql(sql) || params.length !== 1 || !isEligibleUploadKey(key)) {
            throw new Error('拒绝执行未固定的删除语句');
          }
          return conn.query(sql, [key]);
        },
      });
    }),
  });
  if (args.json) console.log(JSON.stringify(report));
  else printReport(report);
  if (report.failures.length > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`上传物过期清理失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
