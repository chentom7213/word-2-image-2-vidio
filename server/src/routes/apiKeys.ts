import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyCreateMessage } from '../lib/api-key-create.js';
import { badRequest } from '../lib/errors.js';
import { apiKeyNameSchema } from '../lib/team-field.js';
import { requireAuth, requireOrg, requireRole } from '../middleware/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys.js';

const createSchema = z.object({
  name: apiKeyNameSchema,
  scopes: z.array(z.enum(['generate:image', 'generate:video', 'assets:read', 'assets:write', '*'])).min(1).default(['*']),
  rateLimit: z.number().int().min(1).max(10000).default(60),
  expiresAt: z.string().datetime().nullable().optional(),
});

export async function apiKeyRoutes(app: FastifyInstance) {
  app.get('/api/api-keys', { preHandler: [requireAuth, requireOrg, requireRole('admin', 'owner')] }, async (req) => {
    const items = await listApiKeys(req.orgId!);
    return { items };
  });

  app.post('/api/api-keys', { preHandler: [requireAuth, requireOrg, requireRole('admin', 'owner')] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = apiKeyCreateMessage(issue?.path[0], req.body);
      throw badRequest(message ?? issue?.message ?? '参数错误');
    }
    const d = parsed.data;
    const key = await createApiKey(req.orgId!, req.userId!, d.name, d.scopes, d.rateLimit, d.expiresAt ?? null);
    return reply.code(201).send({ id: key.id, key: key.plain, prefix: key.prefix });
  });

  app.delete('/api/api-keys/:id', { preHandler: [requireAuth, requireOrg, requireRole('admin', 'owner')] }, async (req) => {
    const { id } = req.params as { id: string };
    await revokeApiKey(req.orgId!, id, req.userId!);
    return { ok: true };
  });
}
