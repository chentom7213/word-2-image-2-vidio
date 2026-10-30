import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { env } from '../../env.js';
import { contentTypeForObjectKey } from '../../lib/output-extension.js';
import type { PutResult, StorageDriver, UploadTarget } from './types.js';

/**
 * S3-compatible driver (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Aliyun OSS
 * in S3-compat mode).
 *
 * SigV4 is implemented inline rather than pulling in `@aws-sdk/client-s3`
 * (~30 MB with its transitive deps) for four HTTP verbs. The algorithm is
 * pinned by published test vectors and covered by unit tests, and the presigned
 * URL format is what every S3 client already understands.
 */

const ALGO = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * Content-Type for a presigned PUT. Blank values stay unsigned. A newline,
 * carriage return, or value longer than 120 characters is replaced so it
 * cannot break the canonical request.
 */
function presignedContentType(contentType: string | undefined): string | undefined {
  if (contentType == null || contentType.length === 0) return undefined;
  if (contentType.length > 120 || /[\r\n]/.test(contentType)) return 'application/octet-stream';
  const trimmed = contentType.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** RFC 3986 encoding — S3 signs the *encoded* form, so this must be exact. */
function uriEncode(input: string, encodeSlash = true): string {
  const bytes = Buffer.from(input, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function amzDate(now = new Date()): { date: string; timestamp: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { date: iso.slice(0, 8), timestamp: iso };
}

function signingKey(secret: string, date: string, region: string, service: string = SERVICE): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted gateways require path-style addressing. */
  forcePathStyle: boolean;
  sessionToken?: string;
  /** Optional public CDN base; when set, `signedUrl` returns a CDN URL. */
  publicBaseUrl?: string;
};

export function s3ConfigFromEnv(): S3Config {
  const s = env.storage.s3;
  return {
    endpoint: s.endpoint.replace(/\/+$/, ''),
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    forcePathStyle: s.forcePathStyle,
    sessionToken: s.sessionToken,
    publicBaseUrl: s.publicBaseUrl,
  };
}

/** Rewrites the `/media/...` URL that the rest of the app expects. */
function s3Driver(config: S3Config): StorageDriver {
  const basePath = new URL(config.endpoint).pathname.replace(/\/+$/, '');

  /** Canonical path: `/bucket/key` (path-style) or `/key` (virtual-hosted). */
  function canonicalPath(objectKey: string): string {
    const key = objectKey.replace(/^\/+/, '');
    return config.forcePathStyle
      ? `${basePath}/${uriEncode(config.bucket, false)}/${uriEncode(key, false)}`
      : `${basePath}/${uriEncode(key, false)}`;
  }

  function objectUrl(objectKey: string): string {
    if (config.forcePathStyle) {
      return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${objectKey
        .replace(/^\/+/, '')
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')}`;
    }
    const u = new URL(config.endpoint);
    return `${u.protocol}//${config.bucket}.${u.host}${basePath}/${objectKey
      .replace(/^\/+/, '')
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/')}`;
  }

  /** Header names sorted so SignedHeaders and the canonical block stay aligned. */
  function signedHeaderEntries(
    timestamp: string,
    objectKey: string,
    contentType?: string,
  ): [string, string][] {
    const host = new URL(objectUrl(objectKey)).host;
    const entries: [string, string][] = [
      ['host', host],
      ['x-amz-content-sha256', UNSIGNED_PAYLOAD],
      ['x-amz-date', timestamp],
    ];
    if (contentType) entries.push(['content-type', contentType]);
    if (config.sessionToken) entries.push(['x-amz-security-token', config.sessionToken]);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return entries;
  }

  function headers(
    timestamp: string,
    signature: string,
    signedHeaders: string,
    contentType?: string,
  ): Record<string, string> {
    const h: Record<string, string> = {
      'x-amz-content-sha256': UNSIGNED_PAYLOAD,
      'x-amz-date': timestamp,
      Authorization:
        `${ALGO} Credential=${config.accessKeyId}/${timestamp.slice(0, 8)}/${config.region}/${SERVICE}/aws4_request, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    if (contentType) h['Content-Type'] = contentType;
    if (config.sessionToken) h['x-amz-security-token'] = config.sessionToken;
    return h;
  }

  /** Signs a request whose payload is streamed (hash advertised as UNSIGNED). */
  function signRequest(
    method: string,
    objectKey: string,
    now = new Date(),
    contentType?: string,
  ): Record<string, string> {
    const { date, timestamp } = amzDate(now);
    const entries = signedHeaderEntries(timestamp, objectKey, contentType);
    const signed = entries.map(([name]) => name).join(';');
    const canonicalHeaderBlock = `${entries.map(([name, value]) => `${name}:${value}`).join('\n')}\n`;
    const canonicalRequest = [
      method,
      canonicalPath(objectKey),
      '', // no query string
      canonicalHeaderBlock,
      signed,
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGO, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(config.secretAccessKey, date, config.region))
      .update(stringToSign)
      .digest('hex');

    return headers(timestamp, signature, signed, contentType);
  }

  async function request(
    method: string,
    objectKey: string,
    body?: Buffer | Readable,
    contentLength?: number,
  ): Promise<Response> {
    const url = objectUrl(objectKey);
    // Only PUT carries Content-Type. HEAD and DELETE keep the previous headers.
    const contentType = method === 'PUT' ? contentTypeForObjectKey(objectKey) ?? undefined : undefined;
    const h = signRequest(method, objectKey, new Date(), contentType);
    // S3 rejects a chunked body without Content-Length. A Buffer body gets the
    // header from fetch automatically; a stream has to be told its size.
    if (contentLength !== undefined) h['content-length'] = String(contentLength);
    const init: RequestInit & { duplex?: 'half' } = { method, headers: h };
    if (body instanceof Readable) {
      // Stream the file instead of buffering a 50MB upload in memory.
      init.body = Readable.toWeb(body) as unknown as RequestInit['body'];
      init.duplex = 'half';
    } else if (body) {
      init.body = body as unknown as RequestInit['body'];
    }
    return fetch(url, init);
  }

  return {
    id: 's3',

    async put(objectKey, data) {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      const res = await request('PUT', objectKey, buf);
      if (!res.ok) {
        throw new Error(`S3 PUT ${objectKey} 失败: ${res.status} ${await res.text().catch(() => '')}`);
      }
      return { objectKey, bytes: buf.byteLength };
    },

    async putFromPath(objectKey, srcPath) {
      const info = await stat(srcPath);
      const stream = createReadStream(srcPath);
      try {
        const res = await request('PUT', objectKey, stream, info.size);
        if (!res.ok) {
          throw new Error(`S3 PUT ${objectKey} 失败: ${res.status} ${await res.text().catch(() => '')}`);
        }
        return { objectKey, bytes: info.size };
      } finally {
        stream.destroy();
      }
    },

    async exists(objectKey) {
      const res = await request('HEAD', objectKey);
      return res.ok;
    },

    async size(objectKey) {
      const res = await request('HEAD', objectKey);
      if (!res.ok) return 0;
      return Number(res.headers.get('content-length') ?? 0);
    },

    async remove(objectKey) {
      const res = await request('DELETE', objectKey);
      // S3 DELETE is idempotent: 204 even when the key is absent.
      if (!res.ok && res.status !== 404) {
        throw new Error(`S3 DELETE ${objectKey} 失败: ${res.status}`);
      }
    },

    signedUrl(objectKey, ttlSec = env.storage.signTtl) {
      if (!objectKey) return null;
      if (objectKey.startsWith('/') || /^https?:\/\//i.test(objectKey)) return objectKey;

      // A CDN in front of the bucket is the whole point of using S3; when it is
      // configured we hand the client the CDN URL and let the CDN do auth.
      if (config.publicBaseUrl) {
        return `${config.publicBaseUrl.replace(/\/+$/, '')}/${objectKey
          .replace(/^\/+/, '')
          .split('/')
          .map((s) => encodeURIComponent(s))
          .join('/')}`;
      }

      return presignedUrl('GET', objectKey, ttlSec);
    },

    localPath() {
      return null;
    },

    async openRange() {
      // Remote bytes are fetched by the client from the store, never proxied.
      return null;
    },

    async presignUpload(objectKey, ttlSec = 900, contentType?: string): Promise<UploadTarget> {
      const signedType = presignedContentType(contentType);
      // Query-string auth already carries UNSIGNED-PAYLOAD. Returning
      // x-amz-content-sha256 here would make the browser send a header that
      // is not in SignedHeaders, and S3 rejects that.
      const uploadHeaders: Record<string, string> = {};
      if (signedType) uploadHeaders['Content-Type'] = signedType;
      return {
        url: presignedUrl('PUT', objectKey, ttlSec, signedType),
        method: 'PUT',
        headers: uploadHeaders,
        expiresInSec: ttlSec,
      };
    },
  };

  /**
   * Presigned URL (query-string auth). `UNSIGNED-PAYLOAD` is required for PUT
   * because the browser will not compute a payload hash. A PUT content type
   * is a signed header (`content-type` then `host`). A GET adds
   * `response-content-type` when the key extension is known, and that query
   * parameter is part of the canonical request.
   */
  function presignedUrl(method: string, objectKey: string, ttlSec: number, contentType?: string): string {
    const host = new URL(objectUrl(objectKey)).host;
    const { date, timestamp } = amzDate();
    const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;
    const credential = `${config.accessKeyId}/${scope}`;
    const signedHeaderNames = contentType ? 'content-type;host' : 'host';

    const query: Record<string, string> = {
      'X-Amz-Algorithm': ALGO,
      'X-Amz-Credential': credential,
      'X-Amz-Date': timestamp,
      'X-Amz-Expires': String(Math.min(Math.max(ttlSec, 1), 604800)),
      'X-Amz-SignedHeaders': signedHeaderNames,
    };
    if (config.sessionToken) query['X-Amz-Security-Token'] = config.sessionToken;
    if (method === 'GET') {
      const responseType = contentTypeForObjectKey(objectKey);
      if (responseType) query['response-content-type'] = responseType;
    }

    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join('&');

    const canonicalHeaderBlock = contentType
      ? `content-type:${contentType}\nhost:${host}\n`
      : `host:${host}\n`;

    const canonicalRequest = [
      method,
      canonicalPath(objectKey),
      canonicalQuery,
      canonicalHeaderBlock,
      signedHeaderNames,
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [ALGO, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(config.secretAccessKey, date, config.region))
      .update(stringToSign)
      .digest('hex');

    const sep = objectUrl(objectKey).includes('?') ? '&' : '?';
    return `${objectUrl(objectKey)}${sep}${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}

export const s3 = s3Driver;

/** Exposed for unit tests — the SigV4 building blocks, no network involved. */
export const __sigv4 = { uriEncode, sha256Hex, hmac, amzDate, signingKey, s3Driver };
