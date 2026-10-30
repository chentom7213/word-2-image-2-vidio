import type { FastifyInstance } from 'fastify';
import { statSync } from 'node:fs';
import { contentTypeForObjectKey } from '../lib/output-extension.js';
import { storage, storageDriverId } from '../services/storage/index.js';
import { verifyLocalSignature } from '../services/storage/local.js';

/**
 * Serves artifacts behind HMAC-signed, expiring URLs.
 *
 * Local driver: streams the file with Range support so `<video>` can seek
 * without downloading the whole clip.
 *
 * S3 driver: the bytes live in the bucket and the client receives a presigned
 * bucket URL directly, so a request reaching here is a stale link or a legacy
 * row. We 302 to the presigned URL rather than proxying the body — proxying
 * would give up the entire benefit of object storage.
 */
export async function mediaRoutes(app: FastifyInstance) {
  const directUploadLimit = 50 * 1024 * 1024;
  const asBuffer = (_req: unknown, body: Buffer, done: (error: Error | null, value?: Buffer) => void) =>
    done(null, body);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: directUploadLimit }, asBuffer);
  app.addContentTypeParser(/^(image|video|audio)\//, { parseAs: 'buffer', bodyLimit: directUploadLimit }, asBuffer);

  app.put('/media/*', { bodyLimit: directUploadLimit }, async (req, reply) => {
    if (storageDriverId !== 'local') {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '当前存储驱动不接受本地直传' });
    }
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    let objectKey: string;
    try {
      objectKey = decodeURIComponent(wildcard);
    } catch {
      return reply.code(400).send({ error: 'BAD_KEY', message: '非法资源路径编码' });
    }
    const { e, s } = req.query as { e?: string; s?: string };
    const verdict = verifyLocalSignature('put', objectKey, e, s);
    if (verdict === 'expired') {
      return reply.code(403).send({ error: 'URL_EXPIRED', message: '上传链接已过期，请重新获取' });
    }
    if (verdict !== 'ok') {
      return reply.code(403).send({ error: 'BAD_SIGNATURE', message: '上传链接签名无效' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: '上传内容为空' });
    }
    const saved = await storage.put(objectKey, body);
    return reply.code(201).send({ ok: true, bytes: saved.bytes });
  });

  app.get('/media/*', async (req, reply) => {
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    let objectKey: string;
    try {
      objectKey = decodeURIComponent(wildcard);
    } catch {
      return reply.code(400).send({ error: 'BAD_KEY', message: '非法资源路径编码' });
    }
    const { e, s } = req.query as { e?: string; s?: string };

    const verdict = verifyLocalSignature('get', objectKey, e, s);
    if (verdict === 'expired') {
      return reply.code(403).send({ error: 'URL_EXPIRED', message: '下载链接已过期，请刷新页面' });
    }
    if (verdict !== 'ok') {
      return reply.code(403).send({ error: 'BAD_SIGNATURE', message: '链接签名无效' });
    }

    if (storageDriverId !== 'local') {
      const target = storage.signedUrl(objectKey);
      if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });
      return reply.redirect(target, 302);
    }

    const abs = storage.localPath(objectKey);
    if (!abs) return reply.code(400).send({ error: 'BAD_KEY', message: '非法资源路径' });

    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在或已清理' });
    }

    const mime = contentTypeForObjectKey(objectKey) ?? 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || end < start) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).send();
        }
        const stream = await storage.openRange(objectKey, { start, end });
        if (!stream) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });
        return reply
          .code(206)
          .headers({
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=600',
          })
          .send(stream);
      }
    }

    const stream = await storage.openRange(objectKey, { start: 0, end: Math.max(0, size - 1) });
    if (!stream) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });

    return reply
      .headers({
        'Content-Type': mime,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=600',
      })
      .send(stream);
  });
}
