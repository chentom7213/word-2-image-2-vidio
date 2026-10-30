/** 成员角色 Zod 路径第一段。role 换成中文，其余交给原 message。 */
export function memberRoleMessage(issuePath: PropertyKey | undefined): string | null {
  if (issuePath === 'role') return '角色无效';
  return null;
}
