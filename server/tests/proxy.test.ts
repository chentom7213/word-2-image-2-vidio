import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustSingleProxyHop } from '../src/lib/proxy.js';

describe('single nginx proxy trust', () => {
  it('uses nginx-provided client IP but does not trust another forwarded hop', async () => {
    const app = Fastify({ trustProxy: trustSingleProxyHop });
    app.get('/ip', async (request) => ({ ip: request.ip, ips: request.ips }));

    const proxied = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '172.20.0.5',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(proxied.json()).toEqual({ ip: '203.0.113.9', ips: ['172.20.0.5', '203.0.113.9'] });

    const spoofedChain = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '172.20.0.5',
      headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.9' },
    });
    expect(spoofedChain.json().ip).toBe('203.0.113.9');
    await app.close();
  });
});
