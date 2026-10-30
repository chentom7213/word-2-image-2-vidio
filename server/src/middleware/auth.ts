import type { FastifyRequest } from 'fastify';
import { bearerFrom, verifyToken } from '../lib/jwt.js';
import { unauthorized, forbidden, ApiError } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { ensurePersonalOrg, getMembership } from '../services/orgs.js';
import { verifyApiKey } from '../services/apiKeys.js';
import { accountIsClosed } from '../services/account-erasure.js';
import { accessIssuedBeforeCutoff } from '../services/access-cutoff.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    orgId?: string;
    role?: string;
    apiScopes?: string[];
    apiKeyId?: string;
  }
}

/** Extracts and verifies the Bearer token, attaching `request.userId`. */
export async function requireAuth(req: FastifyRequest) {
  const apiKey = (req.headers['x-api-key'] as string | undefined)?.trim();
  if (apiKey) {
    const ctx = await verifyApiKey(apiKey);
    await rejectIfClosed(ctx.userId);
    req.userId = ctx.userId;
    req.orgId = ctx.orgId;
    req.role = 'editor';
    req.apiScopes = ctx.scopes;
    req.apiKeyId = ctx.keyId;
    return;
  }

  const token = bearerFrom(req.headers.authorization);
  if (!token) throw unauthorized();
  const payload = verifyToken(token);
  await rejectIfClosed(payload.sub);
  await rejectIfAccessRevoked(payload.sub, payload.iat);
  req.userId = payload.sub;
  // Resolve a default organization for the user (auto-provisioned on first use).
  try {
    const requested = (req.headers['x-org-id'] as string | undefined)?.trim();
    if (requested) {
      const requestedRole = await getMembership(payload.sub, requested);
      if (requestedRole) {
        req.orgId = requested;
        req.role = requestedRole;
        return;
      }
    }
    req.orgId = await ensurePersonalOrg(payload.sub, payload.email);
    const role = await getMembership(payload.sub, req.orgId);
    req.role = role ?? 'viewer';
  } catch {
    req.orgId = undefined;
    req.role = 'viewer';
  }
}

export function accountIsSuspended(user: { suspended_at?: unknown } | null | undefined): boolean {
  if (!user) return false;
  const value = user.suspended_at;
  return value != null && value !== '';
}

/**
 * Suspended accounts cannot keep a session. A missing `suspended_at` column is
 * ignored the same way a failed `deleted_at` lookup is ignored, so an unmigrated
 * database does not lock the API. Closed accounts are rejected by the caller first.
 */
export async function rejectSuspendedAccount(userId: string): Promise<void> {
  try {
    const row = await queryOne<{ suspended_at?: string | null }>(
      'SELECT suspended_at FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    if (row && accountIsSuspended(row)) throw unauthorized('账户已停用');
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }
}

/**
 * Access tokens issued at or before `tokens_valid_after` are dead. A missing
 * column is ignored, matching the unmigrated-database behavior of suspension.
 * API keys do not call this.
 */
export async function rejectIfAccessRevoked(userId: string, iat: number | undefined): Promise<void> {
  try {
    const row = await queryOne<{ tokens_valid_after?: unknown }>(
      'SELECT tokens_valid_after FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    if (row && accessIssuedBeforeCutoff(iat, row.tokens_valid_after)) {
      throw unauthorized('登录已失效，请重新登录');
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }
}

/** A closed account cannot keep using an access token or API key that was issued earlier. */
export async function rejectIfClosed(userId: string): Promise<void> {
  try {
    const row = await queryOne<{ deleted_at?: string | null }>(
      'SELECT deleted_at FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
    if (row && accountIsClosed(row)) throw unauthorized('账户已注销');
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }
  await rejectSuspendedAccount(userId);
}

/** Requires the caller to belong to an organization (resolved by requireAuth). */
export async function requireOrg(req: FastifyRequest) {
  if (!req.orgId) throw forbidden('未加入任何组织');
}

/** Ensures `:id` in the URL matches the caller's resolved organization. */
export async function requireOrgParam(req: FastifyRequest) {
  const id = (req.params as { id?: string } | undefined)?.id;
  if (id && req.orgId !== id) throw forbidden('组织不匹配');
}

/** Role guard — must run after requireAuth. */
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest) => {
    if (!req.role || !roles.includes(req.role)) {
      throw forbidden('权限不足');
    }
  };
}

/** Session users have no scope list and are allowed through. `*` allows every scope. */
export function apiScopeAllows(scopes: string[] | undefined, required: string[]): boolean {
  if (!scopes) return true;
  if (scopes.includes('*')) return true;
  return required.some((scope) => scopes.includes(scope));
}

/** Image/video types an API key may touch. `null` means the caller is not scope-limited. */
export function scopedGenerationTypes(scopes: string[] | undefined): Array<'image' | 'video'> | null {
  if (!scopes || scopes.includes('*')) return null;
  const types: Array<'image' | 'video'> = [];
  if (scopes.includes('generate:image')) types.push('image');
  if (scopes.includes('generate:video')) types.push('video');
  return types;
}

export function assertApiScope(req: FastifyRequest, ...required: string[]) {
  if (!apiScopeAllows(req.apiScopes, required)) throw forbidden('API Key 缺少所需权限');
}

/** Restrict API-key callers to a scope (session users are unaffected). */
export function requireScope(scope: string) {
  return async (req: FastifyRequest) => {
    assertApiScope(req, scope);
  };
}

/** Allow selecting an explicit org via X-Org-Id header. */
export async function resolveOrg(req: FastifyRequest) {
  if (!req.userId || req.apiKeyId) return;
  const requested = (req.headers['x-org-id'] as string | undefined)?.trim();
  if (requested) {
    const role = await getMembership(req.userId, requested);
    if (role) {
      req.orgId = requested;
      req.role = role;
    }
  }
}
