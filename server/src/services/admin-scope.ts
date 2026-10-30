/**
 * Org-admin dashboards only see their own organization.
 * A task with a null org_id is included when its creator is a member, matching
 * the audit log rule for rows written before org_id existed.
 * The Prometheus reconcile gauge stays platform-wide.
 */

export function orgTaskPredicate(): string {
  return '(org_id = ? OR (org_id IS NULL AND user_id IN (SELECT user_id FROM memberships WHERE org_id = ?)))';
}

export function orgMemberPredicate(userColumn: 'user_id' | 'u.id'): string {
  return `${userColumn} IN (SELECT user_id FROM memberships WHERE org_id = ?)`;
}

export function orgTaskParams(orgId: string): [string, string] {
  return [orgId, orgId];
}
