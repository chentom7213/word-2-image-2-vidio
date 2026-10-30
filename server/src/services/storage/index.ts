import { env } from '../../env.js';
import { localDriver, localRoot } from './local.js';
import { s3, s3ConfigFromEnv } from './s3.js';
import type { StorageDriver } from './types.js';

/**
 * Storage facade.
 *
 * Everything downstream (routes, pipeline, DTOs) talks to `storage`, never to a
 * concrete driver. Adding a provider means adding a driver, not editing call
 * sites — and the client contract (`/media/*`-style relative URLs) is unchanged
 * because the driver decides how to sign.
 */
function build(): StorageDriver {
  if (env.storage.driver === 's3') {
    const cfg = s3ConfigFromEnv();
    if (!cfg.accessKeyId || !cfg.secretAccessKey) {
      // Loud at boot rather than mysterious 403s on the first render.
      throw new Error(
        'STORAGE_DRIVER=s3 但未配置 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY',
      );
    }
    return s3(cfg);
  }
  return localDriver;
}

export const storage: StorageDriver = build();
export const storageDriverId = storage.id;

/** Root directory for the local driver (used by static serving + boot logs). */
export const storageRoot = localRoot;

export type { StorageDriver };
export { localDriver };
