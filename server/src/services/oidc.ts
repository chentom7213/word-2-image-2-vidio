import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { oidcIdentityProblem } from '../lib/oidc-length.js';

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

let discoveryCache: { value: Discovery; expiresAt: number } | undefined;

export function oidcEnabled(): boolean {
  return Boolean(
    env.oidc.enabled &&
      env.oidc.issuer &&
      env.oidc.clientId &&
      env.oidc.clientSecret &&
      env.oidc.redirectUri &&
      env.oidc.successRedirect,
  );
}

function configured() {
  if (!env.oidc.enabled) throw new ApiError(404, '企业 SSO 未启用', 'OIDC_DISABLED');
  if (!oidcEnabled()) {
    throw new ApiError(503, '企业 SSO 配置不完整', 'OIDC_MISCONFIGURED');
  }
  return env.oidc;
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function discovery(): Promise<Discovery> {
  const cfg = configured();
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;

  const issuer = normalizeIssuer(cfg.issuer);
  let raw: any;
  try {
    raw = await fetchJson(`${issuer}/.well-known/openid-configuration`);
  } catch (err) {
    throw new ApiError(503, '无法获取企业 SSO 的 OIDC Discovery 文档', 'OIDC_DISCOVERY_FAILED');
  }
  if (
    raw?.issuer !== issuer ||
    typeof raw?.authorization_endpoint !== 'string' ||
    typeof raw?.token_endpoint !== 'string' ||
    typeof raw?.jwks_uri !== 'string'
  ) {
    throw new ApiError(503, '企业 SSO 的 Discovery 文档不合法', 'OIDC_DISCOVERY_INVALID');
  }
  const value: Discovery = raw;
  discoveryCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

export function createOidcState(): { state: string; verifier: string; challenge: string } {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
}

export async function authorizationUrl(state: string, challenge: string): Promise<string> {
  const cfg = configured();
  const meta = await discovery();
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function idTokenForCode(code: string, verifier: string): Promise<JWTPayload> {
  const cfg = configured();
  const meta = await discovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: verifier,
  });
  let token: any;
  try {
    const response = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    token = await response.json();
  } catch {
    throw new ApiError(401, '企业 SSO 授权码交换失败', 'OIDC_TOKEN_EXCHANGE_FAILED');
  }
  if (typeof token?.id_token !== 'string') throw new ApiError(401, '企业 SSO 未返回 ID Token', 'OIDC_TOKEN_INVALID');

  try {
    const jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    const verified = await jwtVerify(token.id_token, jwks, { issuer: meta.issuer, audience: cfg.clientId });
    return verified.payload;
  } catch {
    throw new ApiError(401, '企业 SSO ID Token 验签失败', 'OIDC_TOKEN_INVALID');
  }
}

export function identityClaims(payload: JWTPayload): { issuer: string; subject: string; email: string; name: string | null } {
  const cfg = configured();
  const issuer = normalizeIssuer(cfg.issuer);
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const verified = payload.email_verified === true;
  if (!subject || !email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new ApiError(401, '企业 SSO 未提供有效的 subject 或 email', 'OIDC_CLAIMS_INVALID');
  }
  if (cfg.requireVerifiedEmail && !verified) {
    throw new ApiError(401, '企业 SSO 邮箱尚未验证', 'OIDC_EMAIL_UNVERIFIED');
  }
  const identityProblem = oidcIdentityProblem(issuer, subject);
  if (identityProblem) throw new ApiError(400, identityProblem, 'BAD_REQUEST');
  const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
  return { issuer, subject, email, name: rawName ? rawName.slice(0, 80) : null };
}
