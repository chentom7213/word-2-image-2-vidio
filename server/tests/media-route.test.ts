import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mediaRoutes } from '../src/routes/media.js';
import { localDriver } from '../src/services/storage/local.js';

describe('local signed media route', () => {
  const keys: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(keys.splice(0).map((key) => localDriver.remove(key)));
  });

  it('accepts a signed direct PUT and serves it through a signed GET', async () => {
    const app = Fastify();
    await app.register(mediaRoutes);
    const objectKey = `uploads/test/${randomUUID()}.png`;
    keys.push(objectKey);
    const target = await localDriver.presignUpload!(objectKey, 900);
    const payload = Buffer.from('fake-png-payload');

    const put = await app.inject({
      method: 'PUT',
      url: target.url,
      headers: { 'content-type': 'image/png', ...target.headers },
      payload,
    });
    expect(put.statusCode).toBe(201);
    expect(put.json()).toMatchObject({ ok: true, bytes: payload.length });
    expect(await localDriver.exists(objectKey)).toBe(true);

    const get = await app.inject({ method: 'GET', url: localDriver.signedUrl(objectKey)! });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload).toEqual(payload);
    await app.close();
  });

  it('returns a client error for malformed percent-encoded object keys', async () => {
    const app = Fastify();
    await app.register(mediaRoutes);
    const response = await app.inject({ method: 'GET', url: '/media/bad%25ZZ?e=1&s=x' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'BAD_KEY' });
    await app.close();
  });
});
