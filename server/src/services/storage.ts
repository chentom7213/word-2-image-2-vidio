import { localPathOrNull, localRoot } from './storage/local.js';
import { storage } from './storage/index.js';

/**
 * Back-compat facade for the pre-driver API.
 *
 * Existing call sites (`routes/assets.ts`, `routes/media.ts`, `lib/dto.ts`)
 * import these names directly. Keeping them means the driver refactor did not
 * have to touch every route — and any future rename can be done incrementally.
 *
 * New code should import from `services/storage/index.js` and use `storage.*`.
 */
export { storageRoot } from './storage/index.js';
export type { PutResult } from './storage/types.js';

/** Object-key layout. Identical on both drivers. The month folder is UTC. */
export const keys = {
  output: (userId: string, taskId: string, file: string, now = new Date()) => {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `outputs/${userId}/${yyyy}/${mm}/${taskId}/${file}`;
  },
  upload: (userId: string, file: string, now = new Date()) => {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `uploads/${userId}/${yyyy}/${mm}/${file}`;
  },
};

export const putObject = (objectKey: string, data: Buffer | string) => storage.put(objectKey, data);
export const putObjectFromPath = (objectKey: string, srcPath: string) =>
  storage.putFromPath(objectKey, srcPath);
export const signedUrl = (objectKey: string | null | undefined, ttlSec?: number) =>
  objectKey ? storage.signedUrl(objectKey, ttlSec) : null;

export const objectExists = (objectKey: string) => storage.exists(objectKey);
export const objectSize = (objectKey: string) => storage.size(objectKey);
export const removeObject = (objectKey: string) => storage.remove(objectKey);

/**
 * Local-only escape hatch retained for the media route and asset deletion.
 * Throws for remote drivers so callers cannot silently assume a filesystem.
 */
export function absolutePath(objectKey: string): string {
  const p = localPathOrNull(objectKey);
  if (!p) {
    throw new Error('当前存储驱动为远程对象存储，无法取得本地路径');
  }
  return p;
}

export function localPath(objectKey: string): string | null {
  return localPathOrNull(objectKey);
}

export { localRoot };

/**
 * Signed-request verification for `/media/*`.
 *
 * The URL contract is driver-independent from the client's point of view, but
 * only the local driver serves bytes through this app; the S3 driver returns
 * presigned URLs that point straight at the bucket.
 */
export { verifyLocalSignature as verifySignedRequest } from './storage/local.js';
