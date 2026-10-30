import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { exec, pool, query, queryOne, withTransaction } from '../db/pool.js';
import { accessTtlSeconds, signToken, verifyToken } from '../lib/jwt.js';
import { logoutMayClearCookie } from '../lib/logout-cookie.js';
import { ApiError, badRequest, forbidden, notFound, tooMany, unauthorized } from '../lib/errors.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_TOO_LONG,
  displayNameFromEmail,
  emailSchema,
} from '../lib/email-length.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG } from '../lib/password-length.js';
import { adjustCredits } from '../services/credits.js';
import { accountIsSuspended, rejectSuspendedAccount, requireAuth } from '../middleware/auth.js';
import {
  AccountClosedError,
  AccountMissingError,
  BadPasswordError,
  UnknownUserError,
  accountIsClosed,
  asErasureConnection,
  closeAccount,
  erasureConnectionFromRows,
  loginWithPassword,
  requireOpenUser,
  type ErasureConnection,
} from '../services/account-erasure.js';
import { audit } from '../services/audit.js';
import {
  createSession,
  hashToken,
  listActiveSessionPage,
  refreshCookieName,
  revokeOwnedSession,
  refreshTtlMs,
  revokeAllForUser,
  revokeSession,
  rotateSession,
  userIdFromRefreshCookie,
} from '../services/sessions.js';
import { env } from '../env.js';
import { checkRateLimit } from '../services/ratelimit.js';
import { missingPasswordSetColumn, passwordIsUnset, passwordUpdateSql } from '../services/password-change.js';
import { clearLoginFailures, loginLocked, noteLoginFailure } from '../services/login-lock.js';
import {
  authorizationUrl,
  createOidcState,
  idTokenForCode,
  identityClaims,
  oidcEnabled,
} from '../services/oidc.js';

const credsSchema = z.object({
  email: emailSchema,
  password: z.string().min(6, '密码至少 6 位').max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG),
});

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  credits: number;
  created_at: string;
  deleted_at?: string | null;
  suspended_at?: string | null;
  password_set?: unknown;
};

function accountReads(): ErasureConnection {
  return erasureConnectionFromRows((sql, params) => query(sql, params as any[]));
}

const oidcCookieName = 'benchu_oidc';
const oidcCookieMaxAgeSeconds = 10 * 60;

async function loadPasswordRow(userId: string) {
  try {
    return await queryOne<Pick<UserRow, 'id' | 'password_hash' | 'password_set'>>(
      'SELECT id, password_hash, password_set FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
  } catch (err) {
    if (!missingPasswordSetColumn(err)) throw err;
    return queryOne<Pick<UserRow, 'id' | 'password_hash' | 'password_set'>>(
      'SELECT id, password_hash FROM users WHERE id = ? LIMIT 1',
      [userId],
    );
  }
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    credits: Number(u.credits),
    createdAt: u.created_at,
    passwordSet: !passwordIsUnset(u.password_set),
  };
}

/** Five login attempts per minute per address. The 15-minute lock lives in login-lock.ts. */
const MAX_PER_WINDOW = 5;

function setRefreshCookie(app: FastifyInstance, reply: any, token: string, expiresAt: Date) {
  // Path `/` (not `/api/auth`) because the SSE stream endpoint authenticates
  // from this cookie — EventSource cannot set an Authorization header.
  reply.setCookie(refreshCookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.jwt.cookieSecure,
    domain: env.jwt.cookieDomain,
    maxAge: Math.floor(refreshTtlMs() / 1000),
  });
  reply.header('X-Access-Token-Expires-In', String(accessTtlSeconds()));
}

function clearRefreshCookie(reply: any) {
  reply.clearCookie(refreshCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.jwt.cookieSecure,
    domain: env.jwt.cookieDomain,
  });
}

function presentedBearer(header: string | string[] | undefined): { userId: string | null; unreadable: boolean } {
  const value = Array.isArray(header) ? header[0] : header;
  const bearer = typeof value === 'string' ? /^Bearer\s+(\S+)/i.exec(value.trim()) : null;
  if (!bearer) return { userId: null, unreadable: false };
  try {
    return { userId: verifyToken(bearer[1]).sub, unreadable: false };
  } catch {
    return { userId: null, unreadable: true };
  }
}

/** Clears the refresh cookie only when this request's cookie still belongs to `ownerUserId`. */
async function clearOwnedRefreshCookie(req: any, reply: any, ownerUserId: string | null) {
  const raw = req.cookies?.[refreshCookieName] as string | undefined;
  if (!raw || !ownerUserId) return;
  const cookieUser = await userIdFromRefreshCookie(raw);
  if (!logoutMayClearCookie(ownerUserId, cookieUser)) return;
  clearRefreshCookie(reply);
}

function setOidcCookie(reply: any, value: { state: string; verifier: string }) {
  reply.setCookie(oidcCookieName, JSON.stringify(value), {
    path: '/api/auth/oidc/callback',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.jwt.cookieSecure,
    domain: env.jwt.cookieDomain,
    maxAge: oidcCookieMaxAgeSeconds,
    signed: true,
  });
}

function clearOidcCookie(reply: any) {
  reply.clearCookie(oidcCookieName, {
    path: '/api/auth/oidc/callback',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.jwt.cookieSecure,
    domain: env.jwt.cookieDomain,
  });
}

export async function authRoutes(app: FastifyInstance) {
  const meta = (req: any) => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
  const ipOf = (req: any) => String(req.ip ?? 'unknown');

  /**
   * Distributed login throttle: 5 attempts / minute / IP, and a 15-minute
   * lock after 10 failures. Both live in Redis so API replicas share one budget.
   */
  const loginLimiter = async (req: any) => {
    const ip = ipOf(req);
    await checkRateLimit(`login:${ip}`, MAX_PER_WINDOW, 60, '尝试次数过多，请稍后再试');
    if (await loginLocked(ip)) throw tooMany('尝试次数过多，请 15 分钟后再试');
  };

  /** Lets the SPA decide whether it should show the enterprise SSO entry point. */
  app.get('/api/auth/oidc/config', async () => ({ enabled: oidcEnabled() }));

  /** OIDC Authorization Code + PKCE start. State and verifier never enter JS. */
  app.get('/api/auth/oidc/start', async (_req, reply) => {
    const { state, verifier, challenge } = createOidcState();
    setOidcCookie(reply, { state, verifier });
    return reply.redirect(await authorizationUrl(state, challenge));
  });

  /**
   * OIDC callback: validate signed state cookie + PKCE, exchange the code,
   * verify ID Token against the provider's JWKS, then issue our normal session.
   */
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const parsed = z
      .object({ code: z.string().min(1).optional(), state: z.string().min(1).optional(), error: z.string().optional() })
      .safeParse(req.query);
    if (!parsed.success || parsed.data.error || !parsed.data.code || !parsed.data.state) {
      throw unauthorized('企业 SSO 授权未完成');
    }

    const rawCookie = (req as any).cookies?.[oidcCookieName];
    const unsigned = rawCookie ? (req as any).unsignCookie(rawCookie) : { valid: false };
    clearOidcCookie(reply);
    if (!unsigned.valid || typeof unsigned.value !== 'string') throw unauthorized('企业 SSO state 无效或已过期');

    let saved: { state: string; verifier: string };
    try {
      saved = JSON.parse(unsigned.value);
    } catch {
      throw unauthorized('企业 SSO state 无效或已过期');
    }
    if (saved.state !== parsed.data.state || !saved.verifier) throw unauthorized('企业 SSO state 校验失败');

    const claims = identityClaims(await idTokenForCode(parsed.data.code, saved.verifier));
    const identity = await queryOne<{ user_id: string }>(
      'SELECT user_id FROM oidc_identities WHERE issuer = ? AND subject = ? LIMIT 1',
      [claims.issuer, claims.subject],
    );

    let user: UserRow | undefined;
    if (identity) {
      user = (await queryOne<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1', [identity.user_id])) ?? undefined;
      if (!user) throw unauthorized('企业 SSO 账户已失效');
    } else {
      const existing = await queryOne<UserRow>('SELECT * FROM users WHERE email = ? LIMIT 1', [claims.email]);
      if (existing && accountIsClosed(existing)) throw unauthorized('账户已注销');
      if (existing && accountIsSuspended(existing)) throw unauthorized('账户已停用');
      if (existing && !env.oidc.autoLinkExisting) {
        throw forbidden('此邮箱已有本地账户；请联系管理员批准 SSO 账户关联');
      }
      if (!existing && claims.email.length > EMAIL_MAX_LENGTH) {
        throw badRequest(EMAIL_TOO_LONG);
      }

      const userId = existing?.id ?? randomUUID();
      await withTransaction(async (conn) => {
        if (!existing) {
          // SSO-only accounts retain a non-usable random password hash so the
          // existing schema and password-login code stay backward compatible.
          const unusablePasswordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
          const displayName = (claims.name ?? displayNameFromEmail(claims.email)).slice(0, DISPLAY_NAME_MAX_LENGTH);
          await conn.query(
            'INSERT INTO users (id, email, password_hash, display_name, credits, password_set) VALUES (?, ?, ?, ?, 0, 0)',
            [userId, claims.email, unusablePasswordHash, displayName],
          );
          await adjustCredits(conn, userId, 1000, '企业 SSO 首次登录赠送', null);
        }
        await conn.query(
          'INSERT INTO oidc_identities (issuer, subject, user_id, email_at_link) VALUES (?, ?, ?, ?)',
          [claims.issuer, claims.subject, userId, claims.email],
        );
      });
      user = (await queryOne<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1', [userId])) ?? undefined;
    }

    if (!user) throw unauthorized('企业 SSO 登录失败');
    if (accountIsClosed(user)) throw unauthorized('账户已注销');
    if (accountIsSuspended(user)) throw unauthorized('账户已停用');
    // The access token is minted by the SPA's refresh call. Putting it in the
    // redirect would leak it into logs and the browser history.
    const session = await createSession(user.id, meta(req));
    setRefreshCookie(app, reply, session.token, session.expiresAt);
    await audit({
      userId: user.id,
      action: 'auth.oidc_login',
      target: claims.issuer,
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
    });

    const redirect = new URL(env.oidc.successRedirect);
    redirect.searchParams.set('sso', 'success');
    return reply.redirect(redirect.toString());
  });

  // 注册
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');
    const { email, password } = parsed.data;

    const existing = await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing) throw badRequest('该邮箱已注册');

    const id = randomUUID();
    // cost 12 (OWASP 2024 recommendation); still ~100ms on commodity hardware.
    const hash = await bcrypt.hash(password, 12);
    await withTransaction(async (conn) => {
      await conn.query(
        'INSERT INTO users (id, email, password_hash, display_name, credits) VALUES (?, ?, ?, ?, 0)',
        [id, email, hash, displayNameFromEmail(email)],
      );
      await adjustCredits(conn, id, 1000, '注册赠送', null);
    });

    const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
    const token = signToken({ sub: id, email });
    const session = await createSession(id, meta(req));
    setRefreshCookie(app, reply, session.token, session.expiresAt);
    await audit({ userId: id, action: 'auth.register', target: id, ip: req.ip, ua: req.headers['user-agent'] ?? null });
    return reply.code(201).send({ token, user: publicUser(user!) });
  });

  // 登录
  app.post('/api/auth/login', async (req, reply) => {
    const ip = ipOf(req);
    await loginLimiter(req);

    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');
    const { email, password } = parsed.data;

    let user;
    try {
      user = await loginWithPassword(accountReads(), {
        email,
        password,
        verifyPassword: (plain, hash) => bcrypt.compare(plain, hash),
      });
    } catch (err) {
      if (!(err instanceof UnknownUserError) && !(err instanceof BadPasswordError) && !(err instanceof AccountClosedError)) {
        throw err;
      }
      await noteLoginFailure(ip);
      if (err instanceof AccountClosedError) {
        await audit({
          userId: err.userId,
          action: 'auth.login_failed',
          target: err.userId ?? email,
          ip,
          meta: { reason: 'ACCOUNT_CLOSED' },
        });
        throw unauthorized('账户已注销');
      }
      await audit({
        userId: err instanceof BadPasswordError ? err.userId : null,
        action: 'auth.login_failed',
        target: err instanceof BadPasswordError && err.userId ? err.userId : email,
        ip,
        meta: { reason: err instanceof UnknownUserError ? 'NO_USER' : 'BAD_PASSWORD' },
      });
      throw unauthorized('邮箱或密码错误');
    }

    try {
      await rejectSuspendedAccount(user.id);
    } catch (err) {
      if (err instanceof ApiError && err.message === '账户已停用') {
        await noteLoginFailure(ip);
        await audit({
          userId: user.id,
          action: 'auth.login_failed',
          target: user.id,
          ip,
          meta: { reason: 'ACCOUNT_SUSPENDED' },
        });
      }
      throw err;
    }

    await clearLoginFailures(ip);
    const token = signToken({ sub: user.id, email: user.email });
    const session = await createSession(user.id, meta(req));
    setRefreshCookie(app, reply, session.token, session.expiresAt);
    await audit({ userId: user.id, action: 'auth.login', target: user.id, ip, ua: req.headers['user-agent'] ?? null });
    return reply.send({ token, user: publicUser(user) });
  });

  /**
   * Exchanges the httpOnly refresh cookie for a new access token.
   * Rotates the refresh token on every call; replay revokes the whole family.
   */
  app.post('/api/auth/refresh', async (req, reply) => {
    const raw = (req as any).cookies?.[refreshCookieName];
    if (!raw) throw unauthorized('缺少会话凭证，请重新登录');
    const bearer = presentedBearer(req.headers.authorization);
    const cookieUser = await userIdFromRefreshCookie(raw);
    const mayClear = logoutMayClearCookie(bearer.userId, cookieUser, bearer.unreadable);
    if (!mayClear) throw unauthorized('缺少会话凭证，请重新登录');

    let rotated;
    try {
      rotated = await rotateSession(raw, meta(req));
    } catch (err) {
      clearRefreshCookie(reply);
      throw err;
    }

    let user;
    try {
      user = await requireOpenUser(accountReads(), rotated.userId);
    } catch (err) {
      if (err instanceof AccountClosedError) {
        clearRefreshCookie(reply);
        await revokeAllForUser(rotated.userId);
        throw unauthorized('账户已注销');
      }
      if (err instanceof AccountMissingError) {
        clearRefreshCookie(reply);
        throw unauthorized();
      }
      throw err;
    }

    try {
      await rejectSuspendedAccount(user.id);
    } catch (err) {
      if (err instanceof ApiError && err.message === '账户已停用') {
        clearRefreshCookie(reply);
        await revokeAllForUser(user.id);
      }
      throw err;
    }

    const token = signToken({ sub: user.id, email: user.email });
    setRefreshCookie(app, reply, rotated.token, rotated.expiresAt);
    return reply.send({ token, user: publicUser(user) });
  });

  // 当前用户
  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (req) => {
    const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [req.userId!]);
    if (!user) throw unauthorized();
    return { user: publicUser(user) };
  });

  // 会话列表（安全中心：用户可查看/踢掉自己的登录设备）
  app.get('/api/auth/sessions', { preHandler: [requireAuth] }, async (req) => {
    const raw = (req as any).cookies?.[refreshCookieName] as string | undefined;
    const { limit, before, beforeId } = req.query as {
      limit?: unknown;
      before?: unknown;
      beforeId?: unknown;
    };
    return listActiveSessionPage(req.userId!, raw ?? null, { limit, before, beforeId });
  });

  app.delete('/api/auth/sessions/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const revoked = await revokeOwnedSession(req.userId!, id);
    if (!revoked) throw notFound('会话不存在或已失效');
    const raw = (req as any).cookies?.[refreshCookieName] as string | undefined;
    if (raw && hashToken(raw) === revoked.tokenHash) clearRefreshCookie(reply);
    await audit({
      userId: req.userId!,
      action: 'auth.session_revoke',
      target: id,
      ip: req.ip,
    });
    return { ok: true };
  });

  // 退出：撤销当前 refresh 家族。访问令牌和 cookie 不是同一人时，不动后者。
  app.post('/api/auth/logout', async (req, reply) => {
    const raw = (req as any).cookies?.[refreshCookieName] as string | undefined;
    const header = req.headers.authorization;
    let bearerUser: string | null = null;
    let bearerUnreadable = false;
    const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)/i.exec(header.trim()) : null;
    if (bearer) {
      try {
        bearerUser = verifyToken(bearer[1]).sub;
      } catch {
        bearerUnreadable = true;
      }
    }
    const cookieUser = raw ? await userIdFromRefreshCookie(raw) : null;
    if (!logoutMayClearCookie(bearerUser, cookieUser, bearerUnreadable)) return { ok: true };
    const userId = raw ? await revokeSession(raw) : null;
    clearRefreshCookie(reply);
    await audit({ userId, action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  // 退出所有设备（改密码/怀疑被盗时使用）
  app.post('/api/auth/logout-all', { preHandler: [requireAuth] }, async (req, reply) => {
    await revokeAllForUser(req.userId!);
    await clearOwnedRefreshCookie(req, reply, req.userId!);
    await audit({ userId: req.userId!, action: 'auth.logout_all', ip: req.ip });
    return { ok: true };
  });

  // 改密后旧访问令牌和全部刷新会话都失效，调用方需要重新登录。
  // 还没有本地密码的企业账户可以只提交新密码；已有密码的账户必须带上当前密码。
  app.post('/api/auth/password', { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z
      .object({
        currentPassword: z.string().min(1, '请填写当前密码').max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG).optional(),
        newPassword: z.string().min(6, '密码至少 6 位').max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');

    await checkRateLimit(`password:${req.userId}`, 5, 60, '修改过于频繁，请稍后再试');

    const user = await loadPasswordRow(req.userId!);
    if (!user) throw unauthorized();
    const unset = passwordIsUnset(user.password_set);
    if (!unset) {
      if (!parsed.data.currentPassword) throw badRequest('请填写当前密码');
      const matches = await bcrypt.compare(parsed.data.currentPassword, user.password_hash);
      if (!matches) {
        await audit({
          userId: req.userId!,
          action: 'auth.password_change_failed',
          target: req.userId!,
          ip: req.ip,
          meta: { reason: 'BAD_PASSWORD' },
        });
        throw unauthorized('密码错误');
      }
      if (parsed.data.currentPassword === parsed.data.newPassword) {
        throw badRequest('新密码不能与当前密码相同');
      }
    }

    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    const updated = await exec(passwordUpdateSql(unset), [hash, req.userId!]);
    if (unset && updated.affectedRows === 0) throw badRequest('请填写当前密码');
    await revokeAllForUser(req.userId!);
    await clearOwnedRefreshCookie(req, reply, req.userId!);
    await audit({
      userId: req.userId!,
      action: 'auth.password_change',
      target: req.userId!,
      ip: req.ip,
      ua: req.headers['user-agent'] ?? null,
      meta: unset ? { initial: true } : undefined,
    });
    return { ok: true };
  });

  /**
   * Soft-close. The user row stays so the credit ledger and orders are not
   * cascaded away. A wrong password does not stamp deleted_at. Repeating the
   * call does not move the original timestamp.
   */
  app.post('/api/account/close', { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ password: z.string().min(1, '请填写当前密码').max(PASSWORD_MAX_LENGTH, PASSWORD_TOO_LONG) }).safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? '参数错误');

    const conn = await pool.getConnection();
    try {
      const outcome = await closeAccount(
        asErasureConnection({
          query: (sql, params) => conn.query(sql, params),
          beginTransaction: () => conn.beginTransaction(),
          commit: () => conn.commit(),
          rollback: () => conn.rollback(),
        }),
        {
          userId: req.userId!,
          password: parsed.data.password,
          verifyPassword: (plain, hash) => bcrypt.compare(plain, hash),
        },
      );
      await clearOwnedRefreshCookie(req, reply, req.userId ?? null);
      await audit({
        userId: req.userId!,
        action: 'auth.account_close',
        target: req.userId!,
        ip: req.ip,
        ua: req.headers['user-agent'] ?? null,
        meta: { alreadyClosed: outcome.alreadyClosed },
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof BadPasswordError) {
        await audit({
          userId: req.userId!,
          action: 'auth.account_close_failed',
          target: req.userId!,
          ip: req.ip,
          meta: { reason: 'BAD_PASSWORD' },
        });
        throw unauthorized('密码错误');
      }
      if (err instanceof AccountMissingError) throw unauthorized();
      throw err;
    } finally {
      conn.release();
    }
  });
}
