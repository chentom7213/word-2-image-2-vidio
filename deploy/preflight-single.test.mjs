import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { isPlaceholder, parseArgs, parseComposePs, validateEffectiveConfig } from './preflight-single.mjs';

function fixture(overrides = {}) {
  const apiEnvironment = {
    NODE_ENV: 'development',
    HOST: '0.0.0.0',
    DB_HOST: 'mysql',
    DB_PASSWORD: 'd'.repeat(32),
    REDIS_HOST: 'redis',
    QUEUE_ENABLED: 'true',
    EMBEDDED_WORKER: 'true',
    WORKER_CONCURRENCY: '2',
    FFMPEG_THREADS: '2',
    STORAGE_DRIVER: 'local',
    OUTPUT_DIR: '/app/storage',
    JWT_SECRET: 'j'.repeat(32),
    STORAGE_SIGN_SECRET: 's'.repeat(32),
    PAYMENT_PROVIDER: 'mock',
    PAYMENT_WEBHOOK_SECRET: 'p'.repeat(32),
    PUBLIC_BASE_URL: 'http://10.0.0.8:8080',
    CORS_ORIGIN: 'http://10.0.0.8:8080',
    REFRESH_COOKIE_SECURE: 'false',
    SEED_PASSWORD: 'e'.repeat(16),
    METRICS_TOKEN: 'm'.repeat(32),
    RBAC_MEMBERSHIP_CACHE_TTL_SECONDS: '300',
    ...overrides,
  };
  const logging = { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } };
  const resources = { cpus: 0.5, mem_limit: 512 * 1024 ** 2, pids_limit: 128 };
  return {
    services: {
      mysql: {
        ...resources,
        mem_limit: 1536 * 1024 ** 2,
        environment: { MYSQL_ROOT_PASSWORD: 'r'.repeat(32) },
        logging,
        ports: [{ published: '3307' }],
      },
      redis: {
        ...resources,
        command: ['redis-server', '--maxmemory', '384mb', '--maxmemory-policy', 'noeviction'],
        logging,
        ports: [{ published: '6379' }],
      },
      'storage-init': { ...resources, logging },
      migrate: { ...resources, logging },
      api: {
        ...resources,
        cpus: 2.5,
        mem_limit: 3 * 1024 ** 3,
        environment: apiEnvironment,
        logging,
        stop_grace_period: '5m0s',
        ports: [{ published: '4000' }],
      },
      web: { ...resources, logging, ports: [{ published: '8080' }] },
    },
    volumes: { 'mysql-data': {}, 'redis-data': {}, 'app-storage': {} },
  };
}

test('parseArgs resolves mode and env file', () => {
  const options = parseArgs(['--mode', 'production', '--env-file', 'server.env', '--offline'], '/repo');
  assert.equal(options.mode, 'production');
  assert.equal(path.basename(options.envFile), 'server.env');
  assert.equal(options.offline, true);
});

test('placeholder detection covers shipped defaults', () => {
  for (const value of ['', 'replace-with-secret', 'local-test-secret', 'demo1234', 'rootpw', 'SERVER_IP']) {
    assert.equal(isPlaceholder(value), true, value);
  }
  assert.equal(isPlaceholder('a'.repeat(32)), false);
});

test('valid single-machine test configuration passes policy checks', () => {
  const checks = validateEffectiveConfig(fixture(), { mode: 'test', freeGb: 50, platform: 'linux' });
  assert.deepEqual(
    checks.filter((item) => item.status === 'fail'),
    [],
  );
});

test('loopback API listen address fails the single-machine invariant', () => {
  const checks = validateEffectiveConfig(fixture({ HOST: '127.0.0.1' }), {
    freeGb: 50,
    platform: 'linux',
  });
  assert.equal(
    checks.some((item) => item.code === 'invariant.HOST' && item.status === 'fail'),
    true,
  );
});

test('placeholder secrets fail without leaking their values', () => {
  const secret = 'replace-with-top-secret-value';
  const checks = validateEffectiveConfig(fixture({ JWT_SECRET: secret }), { freeGb: 50, platform: 'linux' });
  assert.equal(
    checks.some((item) => item.code === 'secret.JWT_SECRET' && item.status === 'fail'),
    true,
  );
  assert.equal(JSON.stringify(checks).includes(secret), false);
});

test('HTTPS requires secure cookies', () => {
  const checks = validateEffectiveConfig(
    fixture({
      PUBLIC_BASE_URL: 'https://canvas.example.com',
      CORS_ORIGIN: 'https://canvas.example.com',
      REFRESH_COOKIE_SECURE: 'false',
    }),
    { freeGb: 50, platform: 'linux' },
  );
  assert.equal(
    checks.some((item) => item.code === 'cookie.secure' && item.status === 'fail'),
    true,
  );
});

test('production rejects mock payment and non-HTTPS URL', () => {
  const checks = validateEffectiveConfig(fixture({ NODE_ENV: 'production' }), {
    mode: 'production',
    freeGb: 50,
    platform: 'linux',
  });
  assert.equal(
    checks.some((item) => item.code === 'mode.payment' && item.status === 'fail'),
    true,
  );
  assert.equal(
    checks.some((item) => item.code === 'mode.https' && item.status === 'fail'),
    true,
  );
});

test('CORS must explicitly contain the public origin', () => {
  const checks = validateEffectiveConfig(fixture({ CORS_ORIGIN: 'https://other.example.com' }), {
    freeGb: 50,
    platform: 'linux',
  });
  assert.equal(
    checks.some((item) => item.code === 'url.cors' && item.status === 'fail'),
    true,
  );
});

test('duplicate published ports and insufficient disk fail preflight policy', () => {
  const compose = fixture();
  compose.services.api.ports[0].published = '8080';
  const checks = validateEffectiveConfig(compose, { freeGb: 3, minFreeGb: 20, platform: 'linux' });
  assert.equal(
    checks.some((item) => item.code === 'network.ports' && item.status === 'fail'),
    true,
  );
  assert.equal(
    checks.some((item) => item.code === 'disk.free' && item.status === 'fail'),
    true,
  );
});

test('parseComposePs accepts arrays and JSON lines', () => {
  assert.equal(parseComposePs('[{"Service":"api"}]')[0].Service, 'api');
  assert.deepEqual(
    parseComposePs('{"Service":"api"}\n{"Service":"web"}').map((item) => item.Service),
    ['api', 'web'],
  );
});
