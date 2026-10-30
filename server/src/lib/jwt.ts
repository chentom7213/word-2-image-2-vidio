import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { unauthorized } from './errors.js';

export type JwtPayload = { sub: string; email: string; typ?: 'access'; jti?: string; iat?: number };

export function signToken(payload: JwtPayload): string {
  // `jti` makes every access token unique. Without it, two logins in the same
  // second produce a byte-identical JWT, which breaks token-version revocation.
  return jwt.sign({ ...payload, typ: 'access', jti: randomUUID() }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn as any,
  });
}

export function verifyToken(token: string): JwtPayload {
  try {
    const decoded = jwt.verify(token, env.jwt.secret);
    if (typeof decoded === 'string' || !decoded.sub) throw new Error('bad payload');
    const typ = (decoded as any).typ;
    // Legacy tokens (pre refresh-token migration) carry no `typ`; still accepted
    // so an in-flight deploy does not log every user out.
    if (typ !== undefined && typ !== 'access') throw new Error('wrong token type');
    const iat = (decoded as { iat?: unknown }).iat;
    return {
      sub: String(decoded.sub),
      email: String((decoded as any).email ?? ''),
      typ: 'access',
      jti: (decoded as any).jti,
      iat: typeof iat === 'number' ? iat : undefined,
    };
  } catch {
    throw unauthorized();
  }
}

/** Access-token lifetime in seconds, so the client can refresh proactively. */
export function accessTtlSeconds(): number {
  const raw = env.jwt.expiresIn;
  const m = /^(\d+)\s*([smhd])?$/i.exec(raw.trim());
  if (!m) return 900;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return unit === 'd' ? n * 86400 : unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
}

export function bearerFrom(header?: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
