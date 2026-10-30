import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { query, queryOne, exec } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertApiScope, requireAuth } from '../middleware/auth.js';
import { withTenant } from '../services/tenant-query.js';
import { env } from '../env.js';
import { audit } from '../services/audit.js';
import { keys, putObjectFromPath, removeObject } from '../services/storage.js';
import { storage, storageDriverId } from '../services/storage/index.js';
import { checkRateLimit } from '../services/ratelimit.js';
import { ASSET_FILENAME_MAX_LENGTH, ASSET_FILENAME_TOO_LONG, assetFilenameTooLongMessage } from '../lib/asset-filename.js';
import { parseAssetListKind } from '../lib/asset-list-kind.js';
import { contentTypeForObjectKey } from '../lib/output-extension.js';
import { storedMime } from '../lib/stored-mime.js';
import { resolveAssetUrl, toMillis } from '../lib/dto.js';
import { cursorStamp, generationCursorSql, parseGenerationPage } from '../services/generation-page.js';
import { createUploadToken, verifyUploadToken } from '../services/upload-token.js';

export const MAX_ASSET_BYTES = 50 * 1024 * 1024; // 50MB

/** Local scratch dir for multipart uploads before they reach the object store. */
export const uploadRoot = resolve(process.cwd(), env.uploadDir);

type AssetRow = {
  id: string;
  kind: 'image' | 'video' | 'audio';
  filename: string;
  url: string;
  size: number;
  mime: string | null;
  created_at: string;
};

function toDto(a: AssetRow) {
  return {
    id: a.id,
    kind: a.kind,
    name: a.filename,
    // Stored value is an object key; the client always receives a signed URL.
    url: resolveAssetUrl(a.url),
    size: Number(a.size),
    mime: a.mime,
    createdAt: toMillis(a.created_at),
  };
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

function kindFromMime(mime: string, filename = ''): 'image' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

function safeExtension(kind: 'image' | 'video' | 'audio', filename: string) {
  const ext = extname(filename).toLowerCase();
  const allowed = kind === 'image' ? IMAGE_EXT : kind === 'video' ? VIDEO_EXT : AUDIO_EXT;
  return allowed.has(ext) ? ext : defaultExt(kind);
}

export async function assetRoutes(app: FastifyInstance) {
  mkdirSync(uploadRoot, { recursive: true });

  /** Upload throttles: signed URLs are cheap, bytes are not. */
  const uploadLimiter = async (req: any) => {
    await checkRateLimit(`upload:u:${req.userId}`, 60, 60, '上传过于频繁，请稍后再试');
    await checkRateLimit(`upload:ip:${req.ip}`, 120, 60, '上传过于频繁，请稍后再试');
  };

  app.get('/api/assets/upload-capabilities', { preHandler: [requireAuth] }, async (req) => {
    assertApiScope(req, 'assets:read', 'assets:write');
    return {
      maxBytes: MAX_ASSET_BYTES,
      directSupported: true,
      directRecommended: storageDriverId === 's3',
      thresholdBytes: 5 * 1024 * 1024,
    };
  });

  // 列表
  app.get('/api/assets', { preHandler: [requireAuth] }, async (req) => {
    assertApiScope(req, 'assets:read', 'assets:write');
    const kindFilter = parseAssetListKind(req.query);
    if (kindFilter.error) throw badRequest(kindFilter.error);
    const { limit, before, beforeId } = req.query as {
      limit?: string;
      before?: string;
      beforeId?: string;
    };
    const page = parseGenerationPage({ limit, before, beforeId });
    if (page.error) throw badRequest(page.error);
    const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
    const cursor = generationCursorSql(page.cursor);
    const kind = kindFilter.kind;
    const kindSql = kind ? 'AND kind = ?' : '';
    const kindParams = kind ? [kind] : [];
    const rows = await query<AssetRow>(
      `SELECT * FROM assets WHERE ${tenant.assetReadSql()} ${kindSql} ${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...tenant.assetReadParams(), ...kindParams, ...cursor.params, page.limit],
    );
    const last = rows.length === page.limit ? rows[rows.length - 1] : null;
    const stamp = last ? cursorStamp(last.created_at) : null;
    return {
      items: rows.map(toDto),
      nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
    };
  });

  // 生成签名直传：前端按返回的 method/url/headers 直接 PUT，再 confirm
  app.post('/api/assets/sign', { preHandler: [requireAuth] }, async (req, reply) => {
    assertApiScope(req, 'assets:write');
    await uploadLimiter(req);
    const body = z
      .object({
        filename: z.string().min(1).max(ASSET_FILENAME_MAX_LENGTH, ASSET_FILENAME_TOO_LONG),
        mime: z.string().max(120).optional(),
        size: z.number().int().positive().max(MAX_ASSET_BYTES),
      })
      .safeParse(req.body);
    if (!body.success) {
      const raw = req.body;
      const filename =
        typeof raw === 'object' && raw !== null && 'filename' in raw
          ? (raw as { filename: unknown }).filename
          : undefined;
      if (typeof filename === 'string') {
        const tooLong = assetFilenameTooLongMessage(filename);
        if (tooLong) throw badRequest(tooLong);
      }
      throw badRequest('参数错误');
    }
    const kind = kindFromMime(body.data.mime || '', body.data.filename);
    if (!kind) throw badRequest('仅支持图片/视频/音频文件');
    const ext = safeExtension(kind, body.data.filename);
    const storedName = `${randomUUID()}${ext}`;
    const objectKey = keys.upload(req.userId!, storedName);

    const contentType = body.data.mime?.trim() || 'application/octet-stream';
    const target = await storage.presignUpload(objectKey, 900, contentType);
    if (!target) throw badRequest('当前存储驱动不支持直传，请改用 /api/assets');

    await audit({
      userId: req.userId!,
      orgId: req.orgId,
      action: 'asset.sign',
      meta: { kind, filename: body.data.filename, size: body.data.size },
    });
    return reply.code(201).send({
      uploadUrl: target.url,
      method: target.method,
      headers: target.headers,
      expiresInSec: target.expiresInSec,
      objectKey,
      kind,
      confirmToken: createUploadToken(
        {
          userId: req.userId!,
          orgId: req.orgId ?? null,
          objectKey,
          filename: body.data.filename,
          mime: body.data.mime || contentTypeForObjectKey('file' + ext) || '',
          size: body.data.size,
        },
        target.expiresInSec,
      ),
    });
  });

  // 确认直传：验证绑定上传元数据的令牌，确认对象落盘后幂等写库
  app.post('/api/assets/confirm', { preHandler: [requireAuth] }, async (req, reply) => {
    assertApiScope(req, 'assets:write');
    await uploadLimiter(req);
    const body = z.object({ confirmToken: z.string().min(20).max(4000) }).safeParse(req.body);
    if (!body.success) throw badRequest('参数错误');
    const claims = verifyUploadToken(body.data.confirmToken);
    if (!claims || claims.userId !== req.userId) throw badRequest('上传确认令牌无效或已过期');
    const k = claims.objectKey;
    if (!k.startsWith(`uploads/${req.userId}/`)) {
      throw badRequest('非法的对象路径');
    }

    const existing = await queryOne<AssetRow>('SELECT * FROM assets WHERE user_id = ? AND url = ? LIMIT 1', [
      req.userId!,
      k,
    ]);
    if (existing) return reply.code(200).send({ item: toDto(existing) });

    if (!(await storage.exists(k))) throw badRequest('文件尚未上传完成');
    const size = await storage.size(k);
    if (size <= 0 || size > MAX_ASSET_BYTES || size !== claims.size) {
      await storage.remove(k).catch(() => {});
      throw badRequest(
        size <= 0 ? '上传内容为空' : size > MAX_ASSET_BYTES ? '文件超过 50MB 限制' : '上传文件大小不匹配',
      );
    }
    const ext = extname(k).toLowerCase();
    const kind =
      kindFromMime('', k) ??
      (IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : null);
    if (!kind) {
      await storage.remove(k).catch(() => {});
      throw badRequest('不支持的文件类型');
    }
    const id = randomUUID();
    const filename = k.split('/').pop()!;
    await exec(
      `INSERT INTO assets (id, org_id, user_id, kind, filename, url, size, mime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        id,
        claims.orgId,
        req.userId!,
        kind,
        claims.filename || filename,
        k,
        size,
        storedMime(claims.mime, 120) || contentTypeForObjectKey('file' + ext) || null,
      ],
    );
    const row = await queryOne<AssetRow>('SELECT * FROM assets WHERE user_id = ? AND url = ? LIMIT 1', [
      req.userId!,
      k,
    ]);
    await audit({ userId: req.userId!, orgId: req.orgId, action: 'asset.upload_confirm', target: row!.id, meta: { kind, size } });
    return reply.code(201).send({ item: toDto(row!) });
  });

  // 上传：BFF 直传（大文件请走 /api/assets/sign + 直传，见 README）
  app.post('/api/assets', { preHandler: [requireAuth] }, async (req, reply) => {
    assertApiScope(req, 'assets:write');
    await uploadLimiter(req);
    const data = await req.file({ limits: { fileSize: MAX_ASSET_BYTES } });
    if (!data) throw badRequest('缺少上传文件');
    if (typeof data.filename === 'string') {
      const tooLong = assetFilenameTooLongMessage(data.filename);
      if (tooLong) {
        data.file.resume();
        throw badRequest(tooLong);
      }
    }

    const kind = kindFromMime(data.mimetype || '', data.filename || '');
    if (!kind) throw badRequest('仅支持图片/视频/音频文件');

    const ext = safeExtension(kind, data.filename || '');
    const storedName = `${randomUUID()}${ext}`;
    const scratch = join(tmpdir(), 'benchu-uploads');
    mkdirSync(scratch, { recursive: true });
    const localPath = join(scratch, storedName);

    await pipeline(data.file, createWriteStream(localPath));
    if (data.file.truncated) {
      rmSync(localPath, { force: true });
      throw badRequest('文件超过 50MB 限制');
    }

    const size = statSync(localPath).size;
    const objectKey = keys.upload(req.userId!, storedName);
    await putObjectFromPath(objectKey, localPath);
    rmSync(localPath, { force: true });

    const id = randomUUID();
    await exec(
      'INSERT INTO assets (id, org_id, user_id, kind, filename, url, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.orgId ?? null, req.userId!, kind, data.filename || storedName, objectKey, size, storedMime(data.mimetype, 120)],
    );
    await audit({ userId: req.userId!, orgId: req.orgId, action: 'asset.upload', target: id, meta: { kind, size } });

    const row = await queryOne<AssetRow>('SELECT * FROM assets WHERE id = ?', [id]);
    return reply.code(201).send({ item: toDto(row!) });
  });

  // 删除
  app.delete('/api/assets/:id', { preHandler: [requireAuth] }, async (req) => {
    assertApiScope(req, 'assets:write');
    const { id } = req.params as { id: string };
    const row = await queryOne<AssetRow>('SELECT * FROM assets WHERE id = ? AND user_id = ?', [id, req.userId!]);
    if (!row) throw notFound('素材不存在');
    // Delete the authoritative DB row first. If object-store deletion fails,
    // the lifecycle sweep can safely collect the now-unreferenced object; the
    // inverse order would leave a live DB row pointing at missing bytes.
    const deleted = await exec('DELETE FROM assets WHERE id = ? AND user_id = ?', [id, req.userId!]);
    if (deleted.affectedRows === 0) throw notFound('素材不存在');
    let cleanupFailures = 0;
    // Only remove files that live in the object store (object keys), never
    // legacy external URLs.
    if (!row.url.startsWith('/') && !/^https?:\/\//i.test(row.url)) {
      try {
        await removeObject(row.url);
      } catch {
        cleanupFailures = 1;
      }
    }
    await audit({ userId: req.userId!, orgId: req.orgId, action: 'asset.delete', target: id, meta: { cleanupFailures } });
    return { ok: true, cleanupFailures };
  });
}

function defaultExt(kind: 'image' | 'video' | 'audio') {
  return kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.mp3';
}
