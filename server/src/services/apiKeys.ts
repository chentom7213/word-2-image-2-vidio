import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { query, queryOne, exec } from '../db/pool.js';
import { toMillis } from '../lib/dto.js';
import { ApiError } from '../lib/errors.js';
import { checkRateLimit } from './ratelimit.js';
import { audit } from './audit.js';

export type ApiScope = 'generate:image' | 'generate:video' | 'assets:read' | 'assets:write' | '*';

type KeyRow = {
  id: string;
  org_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[] | string;
  rate_limit: number;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(): { plain: string; prefix: string; hash: string } {
  const plain = `bk_live_${randomBytes(24).toString('hex')}`;
  return { plain, prefix: plain.slice(0, 12), hash: hashKey(plain) };
}

export async function createApiKey(
  orgId: string,
  actorId: string,
  name: string,
  scopes: ApiScope[],
  rateLimit = 60,
  expiresAt: string | null = null,
) {
  const id = randomUUID();
  const k = generateKey();
  await exec(
    'INSERT INTO api_keys (id, org_id, name, key_prefix, key_hash, scopes, rate_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, orgId, name, k.prefix, k.hash, JSON.stringify(scopes), rateLimit, expiresAt],
  );
  await audit({
    userId: actorId,
    orgId,
    action: 'apikey.create',
    target: id,
    meta: { name, prefix: k.prefix, scopes, rateLimit },
  });
  return { id, plain: k.plain, prefix: k.prefix };
}

export async function listApiKeys(orgId: string) {
  const rows = await query<KeyRow>(
    'SELECT id, org_id, name, key_prefix, scopes, rate_limit, expires_at, last_used_at, revoked_at, created_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC',
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    scopes: typeof r.scopes === 'string' ? safeJson(r.scopes) : r.scopes,
    rateLimit: Number(r.rate_limit),
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  }));
}

function safeJson(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function revokeApiKey(orgId: string, id: string, actorId: string) {
  const res = await exec('UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND org_id = ? AND revoked_at IS NULL', [
    id,
    orgId,
  ]);
  if (res.affectedRows === 0) throw new ApiError(404, 'API Key 不存在或已撤销', 'NOT_FOUND');
  await audit({ userId: actorId, orgId, action: 'apikey.revoke', target: id });
}

export type ApiKeyContext = { orgId: string; userId: string; keyId: string; scopes: string[] };

/**
 * Verifies a plaintext API key and returns the org/user context.
 * The owner of the organization is used as the billing subject.
 */
export async function verifyApiKey(plain: string): Promise<ApiKeyContext> {
  const hash = hashKey(plain);
  const row = await queryOne<KeyRow & { owner_id: string }>(
    `SELECT k.*, m.user_id AS owner_id
       FROM api_keys k
       JOIN memberships m ON m.org_id = k.org_id AND m.role = 'owner'
      WHERE k.key_hash = ? LIMIT 1`,
    [hash],
  );
  if (!row) throw new ApiError(401, 'API Key 无效', 'UNAUTHORIZED');
  if (row.revoked_at) throw new ApiError(401, 'API Key 已撤销', 'UNAUTHORIZED');
  if (row.expires_at && toMillis(row.expires_at) < Date.now()) {
    throw new ApiError(401, 'API Key 已过期', 'UNAUTHORIZED');
  }
  await checkRateLimit(`apikey:${row.id}`, Number(row.rate_limit) || 60, 60, 'API Key 请求过于频繁');
  await exec('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]).catch(() => {});
  const scopes = typeof row.scopes === 'string' ? safeJson(row.scopes) : row.scopes;
  return { orgId: row.org_id, userId: row.owner_id, keyId: row.id, scopes };
}

export function hasScope(ctx: ApiKeyContext, scope: ApiScope): boolean {
  if (ctx.scopes.includes('*')) return true;
  return ctx.scopes.includes(scope);
}
