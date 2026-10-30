/** 创建 API Key 的 Zod 路径第一段。scopes / rateLimit / expiresAt 换成中文，名称仍用原来的 message。 */
export function apiKeyCreateMessage(issuePath: PropertyKey | undefined, body: unknown): string | null {
  if (issuePath === 'scopes') {
    return bodyHasEmptyScopes(body) ? '请至少选择一项权限' : '权限项无效';
  }
  if (issuePath === 'rateLimit') return '每分钟上限需为 1 到 10000 的整数';
  if (issuePath === 'expiresAt') return '到期时间无效';
  return null;
}

function bodyHasEmptyScopes(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const scopes = (body as { scopes?: unknown }).scopes;
  return Array.isArray(scopes) && scopes.length === 0;
}
