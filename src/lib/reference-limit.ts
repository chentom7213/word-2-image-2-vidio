import { MAX_ASSET_UPLOAD_BYTES } from './api';
import type { AssetKind } from './types';

/** Reference images and videos follow the asset upload cap. Audio stays at 15MB. */
export function referenceMaxBytes(kind: AssetKind): number {
  switch (kind) {
    case 'image':
    case 'video':
      return MAX_ASSET_UPLOAD_BYTES;
    case 'audio':
      return 15 * 1024 * 1024;
  }
}

/** Reference images allow more attachments than video or audio. */
export function referenceCountMax(kind: AssetKind): number {
  switch (kind) {
    case 'image':
      return 9;
    case 'video':
    case 'audio':
      return 3;
  }
}
