import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { memberRoleMessage } from '../lib/member-role.js';
import { inviteEmailSchema, orgNameSchema } from '../lib/team-field.js';
import { requireAuth, requireOrg, requireOrgParam, requireRole } from '../middleware/auth.js';
import {
  createOrganization,
  inviteMember,
  listMembers,
  listOrgsForUser,
  removeMember,
  updateMemberRole,
} from '../services/orgs.js';

const createSchema = z.object({ name: orgNameSchema });
const inviteSchema = z.object({
  email: inviteEmailSchema,
  role: z.enum(['admin', 'editor', 'viewer']).default('editor'),
});
const roleSchema = z.object({ role: z.enum(['admin', 'editor', 'viewer']) });

export async function tenantRoutes(app: FastifyInstance) {
  app.get('/api/orgs', { preHandler: [requireAuth] }, async (req) => {
    const items = await listOrgsForUser(req.userId!);
    return { items };
  });

  app.post('/api/orgs', { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');
    const id = await createOrganization(parsed.data.name, req.userId!);
    return reply.code(201).send({ id });
  });

  app.get('/api/orgs/:id/members', { preHandler: [requireAuth, requireOrg, requireOrgParam, requireRole('admin', 'owner')] }, async (req) => {
    const { id } = req.params as { id: string };
    const items = await listMembers(id);
    return { items: items.map((m) => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role, createdAt: m.created_at })) };
  });

  app.post('/api/orgs/:id/members', { preHandler: [requireAuth, requireOrg, requireOrgParam, requireRole('admin', 'owner')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = memberRoleMessage(issue?.path[0]);
      throw badRequest(message ?? issue?.message ?? '参数错误');
    }
    const userId = await inviteMember(id, parsed.data.email, parsed.data.role, req.userId!);
    return reply.code(201).send({ userId });
  });

  app.patch('/api/orgs/:id/members/:userId', { preHandler: [requireAuth, requireOrg, requireOrgParam, requireRole('owner')] }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = memberRoleMessage(issue?.path[0]);
      throw badRequest(message ?? issue?.message ?? '参数错误');
    }
    await updateMemberRole(id, userId, parsed.data.role, req.userId!);
    return { ok: true };
  });

  app.delete('/api/orgs/:id/members/:userId', { preHandler: [requireAuth, requireOrg, requireOrgParam, requireRole('admin', 'owner')] }, async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await removeMember(id, userId, req.userId!);
    return { ok: true };
  });
}
