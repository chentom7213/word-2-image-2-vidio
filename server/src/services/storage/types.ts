import type { Readable } from 'node:stream';

export type PutResult = { objectKey: string; bytes: number };

export type ByteRange = { start: number; end: number };

export type UploadTarget = {
  /** Where the client should PUT the bytes. */
  url: string;
  method: 'PUT';
  /** Headers the client must send verbatim for the signature to validate. */
  headers: Record<string, string>;
  expiresInSec: number;
};

export type StorageDriver = {
  readonly id: 'local' | 's3';

  put(objectKey: string, data: Buffer | string): Promise<PutResult>;
  putFromPath(objectKey: string, srcPath: string): Promise<PutResult>;

  exists(objectKey: string): Promise<boolean>;
  size(objectKey: string): Promise<number>;
  remove(objectKey: string): Promise<void>;

  /** Short-lived download URL. Returns null when the key is not signable. */
  signedUrl(objectKey: string, ttlSec?: number): string | null;

  /**
   * Local driver only: absolute filesystem path, so the media route can stream
   * with Range support. Returns null for remote drivers (the client reads
   * directly from the store via the presigned URL instead).
   */
  localPath(objectKey: string): string | null;

  /**
   * Local driver only: opens a byte range for streaming. Null for remote.
   */
  openRange(objectKey: string, range: ByteRange): Promise<Readable | null>;

  /**
   * Direct-to-store upload target. For `local` this points back at our own
   * `/media/*` PUT route; for `s3` it is a presigned PUT.
   * When `contentType` is set, S3 signs that header into the PUT. The local
   * driver ignores it.
   */
  presignUpload(objectKey: string, ttlSec?: number, contentType?: string): Promise<UploadTarget | null>;
};

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'BAD_KEY' | 'UPSTREAM',
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
