import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { query, queryOne, exec, withTransaction } from '../db/pool.js';
import { env } from '../env.js';
import { toMillis } from '../lib/dto.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { sessionIp } from '../lib/session-ip.js';
import { audit } from './audit.js';
import { cursorStamp, generationCursorSql, parseGenerationPage } from './generation-page.js';

/**
 * Refresh-token sessions with rotation and reuse detection.
 *
 * Only the SHA-256 of a token is stored, so a database leak cannot be replayed.
 * Every refresh mints a new token and marks the old one `replaced_by`. If a
 * token that was already rotated is presented again, we treat it as theft and
 * revoke the entire family — the standard OAuth 2.0 BCP recommendation.
 */
export type SessionMeta = { ip?: string | null; userAgent?: string | null };

type RefreshRow = {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(48).toString('base64url');
}

export const refreshCookieName = 'benchu_rt';

export function refreshTtlMs(): number {
  return env.jwt.refreshDays * 24 * 60 * 60 * 1000;
}

function expirySql(ms: number): Date {
  return new Date(Date.now() + ms);
}

/** Issues a brand-new session (login / register). */
export async function createSession(
  userId: string,
  meta: SessionMeta = {},
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = newToken();
  const id = randomUUID();
  const familyId = randomUUID();
  const expiresAt = expirySql(refreshTtlMs());

  await exec(
    `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      familyId,
      hashToken(token),
      expiresAt,
      sessionIp(meta.ip),
      meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
    ],
  );

  return { token, expiresAt, sessionId: id };
}

export type RotateResult = { token: string; expiresAt: Date; userId: string; sessionId: string };

/**
 * Consumes a refresh token and returns a fresh pair.
 * Throws 401 for unknown / expired / revoked / replayed tokens.
 */
export async function rotateSession(rawToken: string, meta: SessionMeta = {}): Promise<RotateResult> {
  const hash = hashToken(rawToken);

  const existing = await queryOne<RefreshRow>(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
    [hash],
  );
  if (!existing) throw new ApiError(401, '登录已失效，请重新登录', 'UNAUTHORIZED');

  if (existing.revoked_at || existing.replaced_by) {
    // A token that was already used is being replayed → assume compromise.
    await revokeFamily(existing.family_id);
    await audit({
      userId: existing.user_id,
      action: 'auth.token_reuse',
      target: existing.family_id,
      meta: { reason: 'replay' },
    });
    throw new ApiError(401, '检测到凭证重复使用，已注销全部会话，请重新登录', 'TOKEN_REUSE');
  }

  if (toMillis(existing.expires_at) <= Date.now()) {
    await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [existing.id]);
    throw new ApiError(401, '登录已过期，请重新登录', 'UNAUTHORIZED');
  }

  const token = newToken();
  const nextId = randomUUID();
  const expiresAt = expirySql(refreshTtlMs());

  await withTransaction(async (conn) => {
    // CAS on `replaced_by IS NULL`: two parallel refreshes race here, and only
    // one may win, otherwise both would receive valid sessions.
    const [res] = await conn.query<any>(
      `UPDATE refresh_tokens SET replaced_by = ?, revoked_at = NOW()
        WHERE id = ? AND replaced_by IS NULL AND revoked_at IS NULL`,
      [nextId, existing.id],
    );
    if (res.affectedRows !== 1) {
      await audit({
        userId: existing.user_id,
        action: 'auth.token_reuse',
        target: existing.family_id,
        meta: { reason: 'race' },
      });
      throw new ApiError(401, '凭证已被使用，请重新登录', 'TOKEN_REUSE');
    }
    await conn.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nextId,
        existing.user_id,
        existing.family_id,
        hashToken(token),
        expiresAt,
        sessionIp(meta.ip),
        meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
      ],
    );
  });

  return { token, expiresAt, userId: existing.user_id, sessionId: nextId };
}

/** Revokes every token descended from the same login. */
export async function revokeFamily(familyId: string): Promise<void> {
  await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL', [
    familyId,
  ]);
}

/** Logout: kills the presented token's whole family (all devices from that login). */
export async function revokeSession(rawToken: string): Promise<string | null> {
  const row = await queryOne<RefreshRow>('SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1', [
    hashToken(rawToken),
  ]);
  if (!row) return null;
  await revokeFamily(row.family_id);
  return row.user_id;
}

/** Used on password change / account lock. Also drops access tokens issued before now. */
export async function revokeAllForUser(userId: string): Promise<void> {
  await exec('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  await stampAccessCutoff(userId);
}

/** Makes JWTs issued at or before this moment fail. API keys are unchanged. */
export async function stampAccessCutoff(userId: string): Promise<void> {
  try {
    await exec('UPDATE users SET tokens_valid_after = UTC_TIMESTAMP(3) WHERE id = ?', [userId]);
  } catch (err) {
    const code = String((err as { code?: string })?.code ?? '');
    const message = String((err as { message?: string })?.message ?? '');
    if (code === 'ER_BAD_FIELD_ERROR' || message.includes('tokens_valid_after')) return;
    throw err;
  }
}

/** Housekeeping for the reaper: drops rows past their expiry plus old revokes. */
export async function pruneExpiredSessions(): Promise<number> {
  const res = await exec(
    `DELETE FROM refresh_tokens
      WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY
         OR (revoked_at IS NOT NULL AND revoked_at < UTC_TIMESTAMP() - INTERVAL 30 DAY)`,
  );
  return res.affectedRows;
}

export async function countActiveSessions(userId: string): Promise<number> {
  const rows = await query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [userId],
  );
  return Number(rows[0]?.c ?? 0);
}

export type ActiveSession = {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
};

/** Callers that omit `limit` keep the historical cap. Generation pages default to 200. */
const SESSION_PAGE_MAX = 50;

function sessionPageSize(rawLimit: unknown, parsedLimit: number): number {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') return SESSION_PAGE_MAX;
  return Math.min(parsedLimit, SESSION_PAGE_MAX);
}

/** Current unreplaced refresh rows. The token hash stays on the server. */
export async function listActiveSessionPage(
  userId: string,
  currentToken: string | null,
  queryArgs: { limit?: unknown; before?: unknown; beforeId?: unknown } = {},
): Promise<{ count: number; items: ActiveSession[]; nextCursor: { createdAt: string; id: string } | null }> {
  const page = parseGenerationPage(queryArgs);
  if (page.error) throw badRequest(page.error);
  const pageSize = sessionPageSize(queryArgs.limit, page.limit);
  const currentHash = currentToken ? hashToken(currentToken) : null;
  const cursor = generationCursorSql(page.cursor);
  const rows = await query<{
    id: string;
    token_hash: string;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
  }>(
    `SELECT id, token_hash, ip, user_agent, created_at
       FROM refresh_tokens
      WHERE user_id = ? AND revoked_at IS NULL AND replaced_by IS NULL AND expires_at > UTC_TIMESTAMP() ${cursor.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [userId, ...cursor.params, pageSize],
  );
  const items = rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    ip: row.ip,
    userAgent: row.user_agent,
    current: currentHash != null && row.token_hash === currentHash,
  }));
  const last = rows.length === pageSize ? rows[rows.length - 1] : null;
  const stamp = last ? cursorStamp(last.created_at) : null;
  return {
    count: items.length,
    items,
    nextCursor: last && stamp ? { createdAt: stamp, id: last.id } : null,
  };
}

export async function listActiveSessions(userId: string, currentToken: string | null): Promise<ActiveSession[]> {
  const page = await listActiveSessionPage(userId, currentToken);
  return page.items;
}

/** Revokes one of the caller's live sessions. Returns the stored hash so the route can clear a matching cookie. */
export async function revokeOwnedSession(userId: string, sessionId: string): Promise<{ tokenHash: string } | null> {
  const row = await queryOne<{ family_id: string; token_hash: string }>(
    `SELECT family_id, token_hash FROM refresh_tokens
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND replaced_by IS NULL
      LIMIT 1`,
    [sessionId, userId],
  );
  if (!row) return null;
  await revokeFamily(row.family_id);
  return { tokenHash: row.token_hash };
}

/**
 * Resolves the user behind a refresh cookie without rotating it.
 * Used by the SSE endpoint, where EventSource cannot send an Authorization
 * header and we do not want a JWT in the URL.
 */
export async function userIdFromRefreshCookie(raw: string | undefined): Promise<string | null> {
  if (!raw) return null;
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM refresh_tokens
      WHERE token_hash = ? AND revoked_at IS NULL AND replaced_by IS NULL AND expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [hashToken(raw)],
  );
  return row?.user_id ?? null;
}
