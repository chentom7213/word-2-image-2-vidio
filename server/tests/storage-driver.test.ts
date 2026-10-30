import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __sigv4, s3 } from '../src/services/storage/s3.js';
import { localDriver, resolveWithinRoot, verifyLocalSignature } from '../src/services/storage/local.js';

const { uriEncode, amzDate, signingKey, sha256Hex, hmac } = __sigv4;
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * SigV4 is hand-rolled here, so its primitives are pinned against the values
 * published in the AWS documentation. If these drift, every S3 request silently
 * starts returning 403 SignatureDoesNotMatch.
 */

describe('uriEncode (RFC 3986)', () => {
  it('leaves unreserved characters alone', () => {
    expect(uriEncode('abcXYZ019-._~')).toBe('abcXYZ019-._~');
  });

  it('encodes spaces as %20, never +', () => {
    expect(uriEncode('a b')).toBe('a%20b');
  });

  it('encodes CJK as UTF-8 octets, uppercase hex', () => {
    // U+4E2D U+6587 → E4 B8 AD E6 96 87
    expect(uriEncode('中文')).toBe('%E4%B8%AD%E6%96%87');
  });

  it('preserves slashes when asked (object keys) and encodes them otherwise', () => {
    expect(uriEncode('a/b/c', false)).toBe('a/b/c');
    expect(uriEncode('a/b/c', true)).toBe('a%2Fb%2Fc');
  });

  it('encodes the characters that actually break presigned URLs', () => {
    expect(uriEncode('a+b')).toBe('a%2Bb');
    expect(uriEncode('a=b')).toBe('a%3Db');
    expect(uriEncode('a&b')).toBe('a%26b');
    expect(uriEncode("a'b")).toBe('a%27b');
  });
});

describe('amzDate', () => {
  it('formats as YYYYMMDDTHHMMSSZ', () => {
    const { date, timestamp } = amzDate(new Date('2013-05-24T00:00:00.000Z'));
    expect(date).toBe('20130524');
    expect(timestamp).toBe('20130524T000000Z');
  });
});

describe('signingKey', () => {
  /**
   * AWS docs "Deriving the signing key" example:
   *   secret=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY
   *   date=20120215, region=us-east-1, service=iam
   *   expected hex = f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d
   *
   * The service name is a parameter precisely so this vector can be checked
   * (our own requests always use `s3`).
   */
  it('matches the published AWS derivation vector', () => {
    const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });
});

describe('sha256Hex', () => {
  it('matches the AWS empty-payload digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('resolveWithinRoot', () => {
  it('accepts a normal key', () => {
    expect(resolveWithinRoot('outputs/u1/2026/01/t/0.png')).toMatch(/0\.png$/);
  });

  it('rejects escapes even after normalization', () => {
    expect(() => resolveWithinRoot('../../etc/passwd')).toThrow(/非法对象路径/);
    expect(() => resolveWithinRoot('a/../../b')).toThrow(/非法对象路径/);
  });

  it('strips leading separators so a key is never absolute', () => {
    expect(resolveWithinRoot('/etc/passwd')).not.toMatch(/^[\\/]etc/);
  });
});

describe('local direct-upload signing', () => {
  it('returns confirmation metadata that verifies the PUT signature', async () => {
    const target = await localDriver.presignUpload!('uploads/user/example.png', 900);
    const url = new URL(target.url, 'http://localhost');
    expect(target.method).toBe('PUT');
    expect(target.headers['X-Upload-Expires']).toBe(url.searchParams.get('e'));
    expect(target.headers['X-Upload-Sig']).toBe(url.searchParams.get('s'));
    expect(
      verifyLocalSignature(
        'put',
        'uploads/user/example.png',
        target.headers['X-Upload-Expires'],
        target.headers['X-Upload-Sig'],
      ),
    ).toBe('ok');
  });

  it('ignores a content type without changing the local PUT signature', async () => {
    const target = await localDriver.presignUpload!('uploads/user/example.png', 900, 'image/png');
    expect(target.headers['Content-Type']).toBeUndefined();
    expect(
      verifyLocalSignature(
        'put',
        'uploads/user/example.png',
        target.headers['X-Upload-Expires'],
        target.headers['X-Upload-Sig'],
      ),
    ).toBe('ok');
  });
});

describe('S3 upload addressing', () => {
  it('uses the bucket host in virtual-hosted presigned URLs', async () => {
    const driver = s3({
      endpoint: 'https://s3.example.test',
      region: 'us-east-1',
      bucket: 'media-bucket',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      forcePathStyle: false,
    });
    const target = await driver.presignUpload('uploads/user/example.png', 900);
    const url = new URL(target!.url);
    expect(url.host).toBe('media-bucket.s3.example.test');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps bucket names in the path for path-style gateways', async () => {
    const driver = s3({
      endpoint: 'http://minio.example.test:9000',
      region: 'us-east-1',
      bucket: 'media-bucket',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
    });
    const target = await driver.presignUpload('uploads/user/example.png', 900);
    const url = new URL(target!.url);
    expect(url.host).toBe('minio.example.test:9000');
    expect(url.pathname).toBe('/media-bucket/uploads/user/example.png');
  });
});

const virtualConfig = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'media-bucket',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  forcePathStyle: false,
};

function canonicalQueryOf(url: URL): string {
  const pairs = [...url.searchParams.entries()].filter(([key]) => key !== 'X-Amz-Signature');
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`).join('&');
}

/** Recomputes the presigned signature from the URL, so a header or query value left out of the canonical request fails. */
function expectPresignedSignature(options: {
  url: string;
  method: string;
  canonicalPath: string;
  canonicalHeaders: string;
  signedHeaders: string;
}) {
  const parsed = new URL(options.url);
  const timestamp = parsed.searchParams.get('X-Amz-Date') ?? '';
  const credential = parsed.searchParams.get('X-Amz-Credential') ?? '';
  const [, date, region, service] = credential.split('/');
  expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe(options.signedHeaders);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const canonicalRequest = [
    options.method,
    options.canonicalPath,
    canonicalQueryOf(parsed),
    options.canonicalHeaders,
    options.signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey('test-secret', date, region, service), stringToSign).toString('hex');
  expect(parsed.searchParams.get('X-Amz-Signature')).toBe(signature);
}

type CapturedRequest = { url: string; headers: Record<string, string> };

async function captureRequest(run: () => Promise<unknown>): Promise<CapturedRequest> {
  let captured: CapturedRequest = { url: '', headers: {} };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers;
    captured = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      headers: { ...(headers as Record<string, string>) },
    };
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    await run();
    return captured;
  } finally {
    globalThis.fetch = previous;
  }
}

function expectAuthorizationSignature(captured: CapturedRequest, method: string, contentType?: string) {
  const url = new URL(captured.url);
  const timestamp = captured.headers['x-amz-date'];
  const entries: [string, string][] = [
    ['host', url.host],
    ['x-amz-content-sha256', UNSIGNED_PAYLOAD],
    ['x-amz-date', timestamp],
  ];
  if (contentType) entries.push(['content-type', contentType]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalHeaders = `${entries.map(([name, value]) => `${name}:${value}`).join('\n')}\n`;
  const date = timestamp.slice(0, 8);
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, UNSIGNED_PAYLOAD].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey('test-secret', date, 'us-east-1'), stringToSign).toString('hex');
  expect(captured.headers.Authorization).toContain(`SignedHeaders=${signedHeaders}`);
  expect(captured.headers.Authorization).toContain(`Signature=${signature}`);
  expect(captured.headers.Authorization).not.toContain('content-length');
  if (contentType) expect(captured.headers['Content-Type']).toBe(contentType);
  else expect(captured.headers['Content-Type']).toBeUndefined();
}

describe('S3 content type signing', () => {
  it('signs image/png into a presigned PUT', async () => {
    const driver = s3(virtualConfig);
    const target = await driver.presignUpload('uploads/user/example.png', 900, 'image/png');
    const url = new URL(target!.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.has('response-content-type')).toBe(false);
    expect(target!.headers).toEqual({
      'Content-Type': 'image/png',
    });
    expectPresignedSignature({
      url: target!.url,
      method: 'PUT',
      canonicalPath: '/uploads/user/example.png',
      canonicalHeaders: `content-type:image/png\nhost:${url.host}\n`,
      signedHeaders: 'content-type;host',
    });
  });

  it('keeps SignedHeaders as host when content type is omitted or blank', async () => {
    const driver = s3(virtualConfig);
    for (const contentType of [undefined, '', '   ']) {
      const target = await driver.presignUpload('uploads/user/example.png', 900, contentType);
      expect(new URL(target!.url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(target!.headers).toEqual({});
    }
  });

  it('signs a newline, carriage return, or overlong type as application/octet-stream', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    try {
      const driver = s3(virtualConfig);
      const fallback = await driver.presignUpload('uploads/user/example.png', 900, 'application/octet-stream');
      const fallbackUrl = new URL(fallback!.url);
      expect(fallback!.headers['Content-Type']).toBe('application/octet-stream');
      expectPresignedSignature({
        url: fallback!.url,
        method: 'PUT',
        canonicalPath: '/uploads/user/example.png',
        canonicalHeaders: `content-type:application/octet-stream\nhost:${fallbackUrl.host}\n`,
        signedHeaders: 'content-type;host',
      });
      const unsafe = ['image/png\nX-Injected: 1', 'image/png\rtext/html', `\n`, 'a'.repeat(121)];
      for (const contentType of unsafe) {
        const target = await driver.presignUpload('uploads/user/example.png', 900, contentType);
        expect(target!.headers).toEqual({
          'Content-Type': 'application/octet-stream',
        });
        expect(new URL(target!.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
        expect(new URL(target!.url).searchParams.get('X-Amz-Signature')).toBe(
          fallbackUrl.searchParams.get('X-Amz-Signature'),
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a 120-character content type', async () => {
    const driver = s3(virtualConfig);
    const contentType = `image/${'a'.repeat(114)}`;
    expect(contentType).toHaveLength(120);
    const target = await driver.presignUpload('uploads/user/example.png', 900, contentType);
    const url = new URL(target!.url);
    expect(target!.headers['Content-Type']).toBe(contentType);
    expectPresignedSignature({
      url: target!.url,
      method: 'PUT',
      canonicalPath: '/uploads/user/example.png',
      canonicalHeaders: `content-type:${contentType}\nhost:${url.host}\n`,
      signedHeaders: 'content-type;host',
    });
  });

  it('adds response-content-type on presigned GET and signs it', () => {
    const driver = s3(virtualConfig);
    const cases: [string, string | null][] = [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['dir/a.webp', 'image/webp'],
      ['a.gif', 'image/gif'],
      ['a.mp4', 'video/mp4'],
      ['a.webm', 'video/webm'],
      ['a.mov', 'video/quicktime'],
      ['a.mp3', 'audio/mpeg'],
      ['a.wav', 'audio/wav'],
      ['a.txt', null],
      ['noext', null],
    ];
    for (const [key, type] of cases) {
      const raw = driver.signedUrl(key, 900)!;
      const url = new URL(raw);
      expect(url.searchParams.get('response-content-type')).toBe(type);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expectPresignedSignature({
        url: raw,
        method: 'GET',
        canonicalPath: url.pathname,
        canonicalHeaders: `host:${url.host}\n`,
        signedHeaders: 'host',
      });
    }
    const png = new URL(driver.signedUrl('outputs/u/0.png', 900)!);
    expect(png.search).toContain('response-content-type=image%2Fpng');
    expect(png.searchParams.get('response-content-type')).toBe('image/png');
  });

  it('returns only the CDN address when publicBaseUrl is set', () => {
    const driver = s3({ ...virtualConfig, publicBaseUrl: 'https://cdn.example.test/media/' });
    expect(driver.signedUrl('outputs/a.png', 900)).toBe('https://cdn.example.test/media/outputs/a.png');
  });

  it('signs Content-Type on server PUT from the key extension', async () => {
    const driver = s3(virtualConfig);
    const png = await captureRequest(() => driver.put('uploads/user/example.png', Buffer.from('png')));
    expectAuthorizationSignature(png, 'PUT', 'image/png');

    const unknown = await captureRequest(() => driver.put('uploads/user/blob', Buffer.from('x')));
    expectAuthorizationSignature(unknown, 'PUT');

    const dir = await mkdtemp(join(tmpdir(), 's3-put-'));
    try {
      const src = join(dir, 'clip');
      await writeFile(src, Buffer.from('webm'));
      const streamed = await captureRequest(() => driver.putFromPath('clips/a.webm', src));
      expect(streamed.headers['content-length']).toBe('4');
      expectAuthorizationSignature(streamed, 'PUT', 'video/webm');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not add Content-Type to HEAD or DELETE', async () => {
    const driver = s3(virtualConfig);
    const head = await captureRequest(() => driver.exists('uploads/user/example.png'));
    expectAuthorizationSignature(head, 'HEAD');
    const deleted = await captureRequest(() => driver.remove('uploads/user/example.png'));
    expectAuthorizationSignature(deleted, 'DELETE');
  });
});
