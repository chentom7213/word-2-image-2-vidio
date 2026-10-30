import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.js';
import { pool, query } from '../db/pool.js';
import { localRoot } from '../services/storage/local.js';
import { collectLifecycleCandidates, deleteLifecycleCandidates } from './storage-lifecycle-lib.js';

type Args = { apply: boolean; json: boolean; minAgeHours: number; maxDelete: number };

function numericFlag(argv: string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && raw === undefined) throw new Error(`${flag} 缺少数值`);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} 必须是非负数字`);
  return value;
}

export function parseArgs(argv: string[]): Args {
  if (argv.includes('--help')) {
    console.log(`用法: npm run storage:lifecycle -- [--apply] [--json] [--min-age-hours N] [--max-delete N]

默认仅预览（dry-run）。只有 --apply 会删除 DB 已无引用且超过保护期的本地对象，
以及遗留在系统临时目录的渲染/上传文件。`);
    process.exit(0);
  }
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    minAgeHours: numericFlag(argv, '--min-age-hours', Number(process.env.STORAGE_CLEANUP_MIN_AGE_HOURS || 24)),
    maxDelete: numericFlag(argv, '--max-delete', Number(process.env.STORAGE_CLEANUP_MAX_DELETE || 1000)),
  };
}

function isObjectKey(value: string | null | undefined): value is string {
  return Boolean(value && !value.startsWith('/') && !/^https?:\/\//i.test(value));
}

async function referencedObjectKeys(): Promise<Set<string>> {
  const outputs = await query<{ object_key: string }>('SELECT object_key FROM task_outputs');
  const assets = await query<{ object_key: string }>('SELECT url AS object_key FROM assets');
  const legacy = await query<{ result_url: string | null; poster_url: string | null }>(
    'SELECT result_url, poster_url FROM generation_tasks WHERE result_url IS NOT NULL OR poster_url IS NOT NULL',
  );
  return new Set(
    [
      ...outputs.map((row) => row.object_key),
      ...assets.map((row) => row.object_key),
      ...legacy.flatMap((row) => [row.result_url, row.poster_url]),
    ].filter(isObjectKey),
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (env.storage.driver !== 'local') {
    throw new Error('storage:lifecycle 只用于 STORAGE_DRIVER=local；S3/OSS 请使用桶生命周期规则');
  }

  // Reference discovery must finish first: a DB outage fails closed.
  const referencedKeys = await referencedObjectKeys();
  const scan = collectLifecycleCandidates({
    storageRoot: localRoot,
    tempRoots: [join(tmpdir(), 'benchu-uploads'), join(tmpdir(), 'benchu-render')],
    referencedKeys,
    minAgeMs: args.minAgeHours * 60 * 60 * 1000,
  });
  if (args.apply && scan.candidates.length > args.maxDelete) {
    throw new Error(`候选文件 ${scan.candidates.length} 个，超过 --max-delete ${args.maxDelete}；请先审阅 dry-run 后显式提高上限`);
  }

  const deletion = args.apply
    ? deleteLifecycleCandidates(scan.candidates)
    : { deleted: 0, bytesDeleted: 0, failures: [] as { path: string; message: string }[] };
  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    storageRoot: localRoot,
    minAgeHours: args.minAgeHours,
    maxDelete: args.maxDelete,
    referencedKeys: referencedKeys.size,
    ...scan,
    ...deletion,
  };

  if (args.json) console.log(JSON.stringify(report));
  else {
    console.log(`存储生命周期清理 · ${report.mode}`);
    console.log(`扫描 ${scan.filesScanned} 个文件；引用中 ${scan.referencedFiles}；保护期内 ${scan.youngFiles}`);
    console.log(`候选 ${scan.candidates.length} 个 / ${humanBytes(scan.bytesReclaimable)}；跳过符号链接 ${scan.symlinksSkipped}`);
    if (args.apply) console.log(`已删除 ${deletion.deleted} 个 / ${humanBytes(deletion.bytesDeleted)}；失败 ${deletion.failures.length}`);
    else console.log('未删除任何文件；确认清单后加 --apply 执行。');
    for (const item of scan.candidates.slice(0, 50)) {
      console.log(`  ${item.reason.padEnd(12)} ${humanBytes(item.bytes).padStart(10)}  ${item.path}`);
    }
    if (scan.candidates.length > 50) console.log(`  … 另有 ${scan.candidates.length - 50} 个候选，请用 --json 查看完整清单`);
  }
  if (deletion.failures.length > 0) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`存储生命周期清理失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
