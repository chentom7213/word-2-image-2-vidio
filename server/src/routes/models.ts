import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors.js';
import { modelListKind } from '../lib/model-list-kind.js';
import { listModels } from '../services/models.js';

export async function modelRoutes(app: FastifyInstance) {
  /** Public: the catalogue is marketing surface, so no auth is required. */
  app.get('/api/models', async (req) => {
    const parsed = modelListKind(req.query as { kind?: unknown });
    if (parsed.error) throw badRequest(parsed.error);
    const items = await listModels(parsed.kind ?? undefined);
    return { items };
  });
}
