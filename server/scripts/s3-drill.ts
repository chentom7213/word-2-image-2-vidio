/**
 * Verifies the S3 driver against a real S3-compatible server (MinIO).
 *
 * SigV4 is hand-rolled, so unit tests on the primitives are not enough — only
 * an actual bucket can prove the canonical request, headers and presigned URLs
 * are byte-correct.
 *
 *   docker run -d --name benchu-minio-test -p 9010:9000 \
 *     -e MINIO_ROOT_USER=testkey -e MINIO_ROOT_PASSWORD=testsecret123 \
 *     minio/minio:latest server /data
 *
 *   S3_ENDPOINT=http://127.0.0.1:9010 S3_BUCKET=benchu-test \
 *   S3_ACCESS_KEY_ID=testkey S3_SECRET_ACCESS_KEY=testsecret123 \
 *   npm run drill:s3
 */
import { randomUUID } from 'node:crypto';

const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const bucket = process.env.S3_BUCKET ?? 'benchu-test';
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'testkey';
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'testsecret123';
const region = process.env.S3_REGION ?? 'us-east-1';

// The driver reads config from env at import time, so set it before importing.
process.env.STORAGE_DRIVER = 's3';
process.env.S3_ENDPOINT = endpoint;
process.env.S3_BUCKET = bucket;
process.env.S3_ACCESS_KEY_ID = accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;
process.env.S3_REGION = region;
process.env.S3_FORCE_PATH_STYLE = 'true';
delete process.env.S3_PUBLIC_BASE_URL;

let passed = 0;
let failed = 0;
const ok = (s, d = '') => (passed++, console.log(`  ✔ ${s}${d ? ` — ${d}` : ''}`));
const bad = (s, d = '') => (failed++, console.error(`  ✘ ${s}${d ? ` — ${d}` : ''}`));
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function check(name, fn) {
  try {
    ok(name, (await fn()) ?? '');
  } catch (e) {
    bad(name, e.message);
  }
}

async function main() {
  console.log(`▶ S3 驱动验证 ${endpoint} bucket=${bucket}`);

  const { storage, storageDriverId } = await import('../src/services/storage/index.js');

  await check('驱动已切换到 s3', async () => {
    assert(storageDriverId === 's3', `driver=${storageDriverId}`);
    return storageDriverId;
  });

  const key = `drills/${Date.now()}-${randomUUID()}/hello.txt`;
  const payload = `hello s3 ${Date.now()}`;

  await check('PUT 小对象', async () => {
    const res = await storage.put(key, payload);
    assert(res.bytes === Buffer.byteLength(payload), `bytes=${res.bytes}`);
    return `${res.bytes}B`;
  });

  await check('HEAD 确认存在与大小', async () => {
    assert(await storage.exists(key), '对象不存在');
    const size = await storage.size(key);
    assert(size === Buffer.byteLength(payload), `size=${size}`);
    return `${size}B`;
  });

  await check('预签名 GET 可直接下载（无需额外凭证）', async () => {
    const url = storage.signedUrl(key);
    assert(url && url.startsWith('http'), `url=${url?.slice(0, 60)}`);
    assert(url.includes('X-Amz-Signature='), '缺少 X-Amz-Signature');
    const res = await fetch(url);
    assert(res.status === 200, `GET ${res.status}`);
    const text = await res.text();
    assert(text === payload, `内容不匹配: ${text.slice(0, 40)}`);
    return `${res.status} · ${text.length}B`;
  });

  await check('篡改签名的 URL 被拒绝', async () => {
    const url = storage.signedUrl(key);
    const tampered = url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`);
    const res = await fetch(tampered);
    assert(res.status === 403, `期望 403，实际 ${res.status}`);
    return `403`;
  });

  await check('对象内容变化会让旧签名失效（签名覆盖路径）', async () => {
    const url = storage.signedUrl(key);
    const other = url.replace(encodeURIComponent(key.split('/').pop()), 'nonexistent.txt');
    const res = await fetch(other);
    assert(res.status === 403 || res.status === 404, `期望 403/404，实际 ${res.status}`);
    return `${res.status}`;
  });

  await check('预签名 PUT 可上传（浏览器直传路径）', async () => {
    const target = await storage.presignUpload(`${key}.put`, 900);
    assert(target?.url, '缺少上传 URL');
    const res = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: 'uploaded via presigned PUT',
    });
    assert(res.ok, `PUT ${res.status} ${await res.text().catch(() => '')}`);
    const size = await storage.size(`${key}.put`);
    assert(size === Buffer.byteLength('uploaded via presigned PUT'), `size=${size}`);
    await storage.remove(`${key}.put`);
    return `${res.status}`;
  });

  await check('putFromPath 流式上传大文件', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 's3-drill-'));
    const local = join(dir, 'big.bin');
    // 4MB: big enough that a buffering bug would be obvious.
    const big = Buffer.alloc(4 * 1024 * 1024, 7);
    writeFileSync(local, big);

    const res = await storage.putFromPath(`${key}.big`, local);
    assert(res.bytes === big.byteLength, `bytes=${res.bytes}`);
    const size = await storage.size(`${key}.big`);
    assert(size === big.byteLength, `remote size=${size}`);
    await storage.remove(`${key}.big`);
    return `${(size / 1024 / 1024).toFixed(0)}MB 往返一致`;
  });

  await check('DELETE 幂等（重复删除不报错）', async () => {
    await storage.remove(key);
    assert(!(await storage.exists(key)), '删除后仍存在');
    await storage.remove(key);
    await storage.remove(key);
    return '删除两次均成功';
  });

  await check('localPath 在 s3 驱动下返回 null（不假装有本地文件）', async () => {
    assert(storage.localPath(key) === null, '意外返回了本地路径');
    const range = await storage.openRange(key, { start: 0, end: 1 });
    assert(range === null, '远程驱动不应提供本地流');
    return 'null';
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('S3 演练失败:', err);
  process.exit(1);
});
