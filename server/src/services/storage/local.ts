import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, normalize, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../../env.js';
import type { ByteRange, PutResult, StorageDriver, UploadTarget } from './types.js';

/**
 * Filesystem driver, laid out exactly like an S3 bucket so a later migration is
 * a copy, not a rewrite:
 *
 *   <root>/outputs/{userId}/{yyyy}/{mm}/{taskId}/{n}.png
 *   <root>/uploads/{userId}/{yyyy}/{mm}/{uuid}.png
 *
 * On a single server this is strictly better than S3: no network hop, no
 * per-request cost, no credentials to rotate.
 */
export const localRoot = resolve(process.cwd(), env.outputDir);

const SIGN_SECRET = env.storage.signSecret;

/**
 * Absolute path for a local object key, or null when the active driver is
 * remote. Callers that only need "is this local?" use this instead of throwing.
 */
export function localPathOrNull(objectKey: string): string | null {
  if (env.storage.driver !== 'local') return null;
  try {
    return resolveWithinRoot(objectKey);
  } catch {
    return null;
  }
}

function sign(scope: string, key: string, expires: number): string {
  return createHmac('sha256', SIGN_SECRET).update(`${scope}:${key}:${expires}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Resolves an object key to an absolute path, refusing anything that escapes
 * the root. `normalize` collapses `..` before the prefix check, so
 * `uploads/../../etc/passwd` cannot slip through.
 */
export function resolveWithinRoot(objectKey: string): string {
  const clean = normalize(objectKey).replace(/^([/\\])+/, '');
  const abs = resolve(localRoot, clean);
  if (abs !== localRoot && !abs.startsWith(localRoot + sep)) {
    throw new Error(`非法对象路径: ${objectKey}`);
  }
  return abs;
}

export const localDriver: StorageDriver = {
  id: 'local',

  async put(objectKey, data) {
    const abs = resolveWithinRoot(objectKey);
    mkdirSync(dirname(abs), { recursive: true });
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    await writeFile(abs, buf);
    return { objectKey, bytes: buf.byteLength };
  },

  async putFromPath(objectKey, srcPath) {
    const abs = resolveWithinRoot(objectKey);
    mkdirSync(dirname(abs), { recursive: true });
    await copyFile(srcPath, abs);
    return { objectKey, bytes: statSync(abs).size };
  },

  async exists(objectKey) {
    return existsSync(resolveWithinRoot(objectKey));
  },

  async size(objectKey) {
    try {
      return statSync(resolveWithinRoot(objectKey)).size;
    } catch {
      return 0;
    }
  },

  async remove(objectKey) {
    rmSync(resolveWithinRoot(objectKey), { force: true });
  },

  signedUrl(objectKey, ttlSec = env.storage.signTtl) {
    if (!objectKey) return null;
    // Legacy rows may hold an external URL or an absolute path; leave them be.
    if (objectKey.startsWith('/') || /^https?:\/\//i.test(objectKey)) return objectKey;
    const expires = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = sign('get', objectKey, expires);
    return `/media/${encodeURI(objectKey)}?e=${expires}&s=${sig}`;
  },

  localPath(objectKey) {
    return resolveWithinRoot(objectKey);
  },

  async openRange(objectKey, range: ByteRange) {
    const abs = resolveWithinRoot(objectKey);
    if (!existsSync(abs)) return null;
    return createReadStream(abs, { start: range.start, end: range.end });
  },

  /**
   * Local direct upload goes back through our own media route, which verifies
   * the same HMAC. Keeping one signing scheme means the client code for a
   * direct PUT is identical on both drivers.
   */
  async presignUpload(objectKey, ttlSec = 900): Promise<UploadTarget> {
    const expires = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = sign('put', objectKey, expires);
    return {
      url: `/media/${encodeURI(objectKey)}?e=${expires}&s=${sig}`,
      method: 'PUT',
      // The client echoes these values to /api/assets/confirm after the PUT.
      // They are metadata for our confirmation call as well as harmless PUT
      // headers; the URL query remains the authorization source.
      headers: {
        'X-Upload-Expires': String(expires),
        'X-Upload-Sig': sig,
      },
      expiresInSec: ttlSec,
    };
  },
};

/** Verifies a `/media/*` URL signature. `scope` separates GET from PUT. */
export function verifyLocalSignature(
  scope: 'get' | 'put',
  objectKey: string,
  expires: string | undefined,
  signature: string | undefined,
): 'ok' | 'expired' | 'bad_signature' {
  if (!expires || !signature) return 'bad_signature';
  const exp = Number(expires);
  if (!Number.isFinite(exp)) return 'bad_signature';
  if (!safeEqual(sign(scope, objectKey, exp), String(signature))) return 'bad_signature';
  if (exp * 1000 < Date.now()) return 'expired';
  return 'ok';
}
