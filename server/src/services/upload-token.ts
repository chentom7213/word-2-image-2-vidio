import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';

const claimsSchema = z.object({
  userId: z.string().min(1).max(64),
  orgId: z.string().min(1).max(64).nullable(),
  objectKey: z.string().min(1).max(500),
  filename: z.string().min(1).max(255),
  mime: z.string().max(120),
  size: z.number().int().positive(),
  expires: z.number().int().positive(),
});

export type UploadClaims = z.infer<typeof claimsSchema>;

function signature(payload: string) {
  return createHmac('sha256', env.storage.signSecret).update(`asset-upload:${payload}`).digest('base64url');
}

export function createUploadToken(
  claims: Omit<UploadClaims, 'expires'>,
  ttlSeconds = 900,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, expires: nowSeconds + Math.max(1, Math.floor(ttlSeconds)) }),
  ).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function verifyUploadToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): UploadClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(signature(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    return claims.expires >= nowSeconds ? claims : null;
  } catch {
    return null;
  }
}
