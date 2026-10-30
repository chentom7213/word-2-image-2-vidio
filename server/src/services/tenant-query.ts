export type TenantCtx = {
  userId: string;
  orgId?: string | null;
};

type ReadableTask = {
  user_id: string;
  org_id: string | null;
  visibility: string;
};

/**
 * User-facing reads go through this helper so the org condition is part of
 * the call, not an optional SQL fragment. Queue workers still load a task by
 * id; that path is not a tenant query.
 */
export function withTenant(ctx: TenantCtx) {
  const userId = ctx.userId;
  const orgId = ctx.orgId?.trim() ?? '';
  if (!userId) throw new Error('withTenant 缺少 userId');

  return {
    userId,
    orgId,
    taskReadSql(): string {
      return "(user_id = ? OR (org_id = ? AND visibility = 'org'))";
    },
    taskReadParams(): [string, string] {
      return [userId, orgId];
    },
    canReadTask(task: ReadableTask): boolean {
      return task.user_id === userId || (task.visibility === 'org' && orgId.length > 0 && task.org_id === orgId);
    },
    assetReadSql(): string {
      return orgId ? 'user_id = ? AND (org_id = ? OR org_id IS NULL)' : 'user_id = ?';
    },
    assetReadParams(): string[] {
      return orgId ? [userId, orgId] : [userId];
    },
  };
}
