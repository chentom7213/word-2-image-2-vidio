import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.js';
import {
  CANVAS_MAX_NODES,
  CANVAS_MAX_TEXT_LENGTH,
  CANVAS_TEXT_TOO_LONG,
  CANVAS_TOO_MANY_NODES,
  canvasBoundsProblem,
  canvasDocumentProblem,
} from '../lib/canvas-limit.js';
import { toMillis } from '../lib/dto.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { requireAuth, requireOrg } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { withTenant } from '../services/tenant-query.js';

const nodeSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(['text', 'image', 'video']),
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  w: z.number().finite().min(40).max(10_000),
  h: z.number().finite().min(40).max(10_000),
  text: z.string().max(CANVAS_MAX_TEXT_LENGTH, CANVAS_TEXT_TOO_LONG).optional(),
  seed: z.string().max(200).optional(),
  assetId: z.string().uuid().nullable().optional(),
});

const documentSchema = z.object({
  version: z.number().int().nonnegative(),
  nodes: z.array(nodeSchema).max(CANVAS_MAX_NODES, CANVAS_TOO_MANY_NODES),
  viewport: z.object({
    zoom: z.number().finite().min(0.4).max(2),
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
  }),
});

type CanvasRow = {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  document_json: string | { nodes?: unknown[]; viewport?: unknown };
  version: number;
  updated_at: string;
};

function toDto(row: CanvasRow) {
  const document = typeof row.document_json === 'string' ? JSON.parse(row.document_json) : row.document_json;
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    nodes: Array.isArray(document.nodes) ? document.nodes : [],
    viewport: document.viewport ?? { zoom: 1, x: 0, y: 0 },
    updatedAt: toMillis(row.updated_at),
  };
}

export async function canvasRoutes(app: FastifyInstance) {
  app.get('/api/canvas', { preHandler: [requireAuth, requireOrg] }, async (req) => {
    const row = await queryOne<CanvasRow>('SELECT * FROM canvas_documents WHERE user_id = ? AND org_id = ? LIMIT 1', [
      req.userId!,
      req.orgId!,
    ]);
    return { item: row ? toDto(row) : null };
  });

  app.put('/api/canvas', { preHandler: [requireAuth, requireOrg] }, async (req, reply) => {
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      const body = req.body;
      const nodes =
        typeof body === 'object' && body !== null && Array.isArray((body as { nodes?: unknown }).nodes)
          ? (body as { nodes: unknown[] }).nodes
          : null;
      const problem = nodes ? canvasDocumentProblem(nodes) : null;
      const bounds =
        problem === null && nodes ? canvasBoundsProblem(nodes, (body as { viewport?: unknown }).viewport) : null;
      throw badRequest(problem ?? bounds ?? parsed.error.issues[0]?.message ?? '画布数据无效');
    }
    if (parsed.data.nodes.some((node) => node.type === 'text' && node.assetId)) {
      throw badRequest('文本节点不能绑定素材');
    }
    const assetIds = [...new Set(parsed.data.nodes.flatMap((node) => (node.assetId ? [node.assetId] : [])))];
    if (assetIds.length > 0) {
      const placeholders = assetIds.map(() => '?').join(',');
      const tenant = withTenant({ userId: req.userId!, orgId: req.orgId });
      const assets = await query<{ id: string; kind: 'image' | 'video' | 'audio' }>(
        `SELECT id, kind FROM assets
          WHERE ${tenant.assetReadSql()} AND id IN (${placeholders})`,
        [...tenant.assetReadParams(), ...assetIds],
      );
      if (assets.length !== assetIds.length) throw badRequest('画布包含无效或无权访问的素材');
      const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
      if (parsed.data.nodes.some((node) => node.assetId && node.type !== kinds.get(node.assetId))) {
        throw badRequest('画布节点类型与素材类型不匹配');
      }
    }

    const payload = JSON.stringify({ nodes: parsed.data.nodes, viewport: parsed.data.viewport });
    let saved: CanvasRow;
    try {
      saved = await withTransaction(async (conn) => {
        const [rows] = await conn.query<any[]>(
          'SELECT * FROM canvas_documents WHERE user_id = ? AND org_id = ? FOR UPDATE',
          [req.userId!, req.orgId!],
        );
        const current = rows[0];
        if (current) {
          if (Number(current.version) !== parsed.data.version) {
            throw new ApiError(409, '画布已在其他页面更新，请刷新后重试', 'CANVAS_VERSION_CONFLICT');
          }
          await conn.query('UPDATE canvas_documents SET document_json = ?, version = version + 1 WHERE id = ?', [
            payload,
            current.id,
          ]);
          const [updated] = await conn.query<any[]>('SELECT * FROM canvas_documents WHERE id = ?', [current.id]);
          return updated[0] as CanvasRow;
        }
        if (parsed.data.version !== 0) {
          throw new ApiError(409, '画布版本不存在，请刷新后重试', 'CANVAS_VERSION_CONFLICT');
        }
        const id = randomUUID();
        await conn.query(
          `INSERT INTO canvas_documents (id, org_id, user_id, name, document_json)
           VALUES (?, ?, ?, '我的画布', ?)`,
          [id, req.orgId!, req.userId!, payload],
        );
        const [created] = await conn.query<any[]>('SELECT * FROM canvas_documents WHERE id = ?', [id]);
        return created[0] as CanvasRow;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ApiError(409, '画布已在其他页面创建，请刷新后重试', 'CANVAS_VERSION_CONFLICT');
      }
      throw error;
    }

    await audit({
      userId: req.userId!,
      orgId: req.orgId!,
      action: 'canvas.save',
      target: saved.id,
      meta: { version: saved.version, nodes: parsed.data.nodes.length },
    });
    return reply.code(parsed.data.version === 0 ? 201 : 200).send({ item: toDto(saved) });
  });
}
