import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pool, query } from '../db/pool.js';
import { localRoot } from '../services/storage/local.js';
import {
  QUARANTINE_PREFIX,
  assertHeldObjectKey,
  assertQuarantineRecord,
  isOutputObjectKey,
  loadReferencedOutputs,
  parseQuarantineManifest,
  parseRetentionArgs,
  readPlanRetentionEnabled,
  runPlanRetention,
  type QuarantineRecord,
  type RetentionReport,
  type RetentionStore,
} from './storage-plan-retention-lib.js';

const USAGE = `用法: npm run storage:plan-retention -- [--apply | --restore | --purge] [--json]
       [--retention-days N] [--recovery-days N] [--key objectKey]

默认 dry-run，且 STORAGE_PLAN_RETENTION 默认关闭（只有精确为 1 才打开）。
只报告免费套餐里仍被任务或素材引用、早于保留天数（默认 30）的 outputs/ 会移到哪里。
不移动、不删除。付费套餐产物不会出现在候选里。

--apply    把候选对象移到 retention-hold/，供恢复窗口内取回。这不是删除。
           STORAGE_PLAN_RETENTION 不是 1 时失败退出，且不改任何对象。
--restore  恢复窗口（默认 7 天）内把隔离对象移回原来的 outputs/ 键。同样必须开关为 1。
           可用 --key 指定对象；省略则恢复窗口内的全部隔离对象。
--purge    只删除已经隔离、并且恢复窗口已经结束的对象。同样必须开关为 1。
           窗口未结束的对象留在隔离区。付费套餐产物即使已在隔离区也不会被删除。

数据库连不上、引用查询失败或隔离清单损坏时失败退出，不移动、不删除。
无引用孤儿仍由 storage:lifecycle 回收；本命令不改变那条删除条件。
S3/OSS 不在这里搬迁，请使用桶生命周期规则。`;

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

function isHeldOutputKey(objectKey: string): boolean {
  return objectKey.startsWith(QUARANTINE_PREFIX) && isOutputObjectKey(objectKey.slice(QUARANTINE_PREFIX.length));
}

function objectPath(root: string, objectKey: string): string {
  if (!isOutputObjectKey(objectKey) && !isHeldOutputKey(objectKey)) throw new Error(`拒绝不安全对象键: ${objectKey}`);
  const abs = resolve(root, ...objectKey.split('/'));
  if (!inside(root, abs)) throw new Error(`对象键越出存储根目录: ${objectKey}`);
  return abs;
}

function assertRegularFile(path: string): void {
  if (!existsSync(path)) throw new Error(`对象不存在: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('拒绝移动或删除符号链接');
  if (!stat.isFile()) throw new Error('拒绝移动或删除非普通文件');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
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

/**
 * Local hold store. Mutations are rename into `retention-hold/` or delete of
 * a manifest record that already lives under that prefix. Live `outputs/`
 * keys are never passed to rmSync.
 */
export function createFilesystemRetentionStore(storageRoot: string): RetentionStore {
  const root = assertSafeRoot(storageRoot);
  const manifest = join(root, 'retention-hold', 'manifest.json');
  const holdOutputs = join(root, 'retention-hold', 'outputs');

  function readManifest(): QuarantineRecord[] {
    if (isSymlink(manifest)) throw new Error('拒绝读取符号链接清单');
    if (!existsSync(manifest)) return [];
    const stat = lstatSync(manifest);
    if (!stat.isFile()) throw new Error('隔离清单不是普通文件，已中止');
    return parseQuarantineManifest(readFileSync(manifest, 'utf8'));
  }

  function writeManifest(records: QuarantineRecord[]): void {
    assertNoSymlink(root, dirname(manifest));
    if (isSymlink(manifest)) throw new Error('拒绝写入符号链接清单');
    for (const record of records) assertQuarantineRecord(record);
    mkdirSync(dirname(manifest), { recursive: true });
    assertNoSymlink(root, manifest);
    const tmp = `${manifest}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, records }, null, 2));
    rmSync(manifest, { force: true });
    renameSync(tmp, manifest);
  }

  function holdTarget(record: QuarantineRecord): string {
    assertQuarantineRecord(record);
    assertHeldObjectKey(record.quarantineKey);
    const target = objectPath(root, record.quarantineKey);
    const rel = relative(holdOutputs, target);
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error(`拒绝删除隔离区以外的对象: ${record.quarantineKey}`);
    }
    return target;
  }

  return {
    has(objectKey) {
      const path = objectPath(root, objectKey);
      if (!existsSync(path)) return false;
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink();
    },
    listQuarantine() {
      return readManifest();
    },
    quarantine(record) {
      assertQuarantineRecord(record);
      const records = readManifest();
      const from = objectPath(root, record.originalKey);
      const to = holdTarget(record);
      assertNoSymlink(root, from);
      assertNoSymlink(root, dirname(to));
      assertRegularFile(from);
      if (isSymlink(to) || existsSync(to)) throw new Error('隔离目标已存在');
      mkdirSync(dirname(to), { recursive: true });
      assertNoSymlink(root, to);
      renameSync(from, to);
      try {
        writeManifest([...records, record]);
      } catch (error) {
        try { renameSync(to, from); } catch { /* the thrown error still aborts the move */ }
        throw error;
      }
    },
    restore(record) {
      assertQuarantineRecord(record);
      const records = readManifest();
      const from = holdTarget(record);
      const to = objectPath(root, record.originalKey);
      assertNoSymlink(root, from);
      assertNoSymlink(root, dirname(to));
      assertRegularFile(from);
      if (isSymlink(to) || existsSync(to)) throw new Error('原路径已存在，拒绝覆盖');
      mkdirSync(dirname(to), { recursive: true });
      assertNoSymlink(root, to);
      renameSync(from, to);
      try {
        writeManifest(records.filter((item) => item.originalKey !== record.originalKey));
      } catch (error) {
        try { renameSync(to, from); } catch { /* keep the restore failure visible */ }
        throw error;
      }
    },
    purge(record) {
      const target = holdTarget(record);
      const records = readManifest();
      assertNoSymlink(root, target);
      if (existsSync(target)) {
        assertRegularFile(target);
        rmSync(target);
      }
      writeManifest(records.filter((item) => item.originalKey !== record.originalKey));
    },
  };
}

function printReport(report: RetentionReport): void {
  console.log(`套餐产物隔离保留 · ${report.mode}`);
  console.log(report.enabled
    ? 'STORAGE_PLAN_RETENTION=1。'
    : 'STORAGE_PLAN_RETENTION 不是 1，默认关闭。');
  console.log(`保留 ${report.retentionDays} 天，恢复窗口 ${report.recoveryDays} 天，隔离前缀 ${report.holdPrefix}`);
  console.log(
    `候选 ${report.candidates.length} 个；排除付费套餐 ${report.excludedPaid.length} 个；` +
    `未满保留期 ${report.excludedYoung.length} 个；非 outputs ${report.excludedOther.length} 个。`,
  );
  for (const notice of report.notices) {
    const who = notice.userId ?? '未知用户';
    console.log(`用户通知 ${who}（${notice.objectKeys.length} 个）：${notice.message}`);
  }
  if (report.mode === 'dry-run') {
    console.log('未移动、未删除任何对象。确认通知名单后，设置 STORAGE_PLAN_RETENTION=1 再执行 --apply。');
  } else if (report.mode === 'apply') {
    console.log(`已隔离 ${report.moved.length} 个到 ${report.holdPrefix}。对象仍可在恢复窗口内 --restore。`);
  } else if (report.mode === 'restore') {
    console.log(`已移回 ${report.restored.length} 个。超过恢复窗口的对象需要另行处理，本次未删除。`);
  } else {
    console.log(`已删除超过恢复窗口的隔离对象 ${report.purged.length} 个。窗口内对象和付费套餐产物未删除。`);
  }
  for (const item of report.candidates.slice(0, 50)) console.log(`  候选  ${item.objectKey}  →  ${item.quarantineKey}`);
  if (report.candidates.length > 50) console.log(`  … 另有 ${report.candidates.length - 50} 个候选，请用 --json 查看`);
  for (const item of report.skipped) console.log(`  跳过  ${item.reason}  ${item.objectKey}`);
  for (const item of report.failures) console.log(`  失败  ${item.objectKey}  ${item.message}`);
  if (report.excludedPaid.length > 0) {
    console.log(`付费套餐产物 ${report.excludedPaid.length} 个未进入隔离，也未删除。`);
  }
}

function runQuery<T>(sql: string): Promise<T[]> {
  return query<T>(sql);
}

function assertLocalDriver(): void {
  const driver = (process.env.STORAGE_DRIVER ?? 'local').trim().toLowerCase();
  if (driver === 's3') throw new Error('storage:plan-retention 只用于 STORAGE_DRIVER=local；S3/OSS 请使用桶生命周期规则');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const args = parseRetentionArgs(argv);
  const enabled = readPlanRetentionEnabled({ STORAGE_PLAN_RETENTION: process.env.STORAGE_PLAN_RETENTION });
  if (args.command !== 'dry-run' && !enabled) {
    throw new Error(`STORAGE_PLAN_RETENTION 不是 1，拒绝执行 ${args.command}，未移动或删除任何对象`);
  }
  assertLocalDriver();
  const store = createFilesystemRetentionStore(localRoot);
  const report = await runPlanRetention({
    command: args.command,
    enabled,
    now: Date.now(),
    retentionDays: args.retentionDays,
    recoveryDays: args.recoveryDays,
    restoreKeys: args.keys,
    store,
    loadReferences: () => loadReferencedOutputs(runQuery),
  });
  if (args.json) console.log(JSON.stringify(report));
  else printReport(report);
  if (report.failures.length > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`套餐产物隔离保留失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
