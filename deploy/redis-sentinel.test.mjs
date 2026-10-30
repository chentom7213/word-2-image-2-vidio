import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultServices = ['api', 'migrate', 'mysql', 'redis', 'storage-init', 'web'];

function composeConfig(files) {
  const args = ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'];
  const stdout = execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

function commandParts(command) {
  if (Array.isArray(command)) return command.map(String);
  return String(command ?? '')
    .split(/\s+/)
    .filter(Boolean);
}

function flagValue(parts, flag) {
  const index = parts.indexOf(flag);
  assert.notEqual(index, -1, `${flag} missing from ${parts.join(' ')}`);
  return parts[index + 1];
}

function environmentMap(environment) {
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment.map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }
  return environment ?? {};
}

function assertAppendOnly(parts) {
  assert.equal(flagValue(parts, '--appendonly'), 'yes');
  assert.equal(parts.includes('--appendonly'), true);
  assert.equal(
    parts.some((part, index) => part === '--appendonly' && parts[index + 1] === 'no'),
    false,
  );
}

test('default compose keeps the single-machine services and the API on redis', () => {
  const config = composeConfig(['docker-compose.yml']);
  assert.deepEqual(Object.keys(config.services).sort(), defaultServices);
  assert.equal(environmentMap(config.services.api.environment).REDIS_HOST, 'redis');
  const redisCommand = commandParts(config.services.redis.command);
  assert.deepEqual(redisCommand, [
    'redis-server',
    '--appendonly',
    'yes',
    '--maxmemory',
    '384mb',
    '--maxmemory-policy',
    'noeviction',
  ]);
  assert.equal(redisCommand.includes('--replica-announce-ip'), false);
  assert.equal(config.services['redis-sentinel'], undefined);
  assert.equal(config.services['redis-replica'], undefined);
});

test('sentinel overlay adds a replica and sentinel while the API stays on redis', () => {
  const config = composeConfig(['docker-compose.yml', 'docker-compose.redis-sentinel.yml']);
  assert.deepEqual(Object.keys(config.services).sort(), [...defaultServices, 'redis-replica', 'redis-sentinel'].sort());

  const apiEnvironment = environmentMap(config.services.api.environment);
  assert.equal(apiEnvironment.REDIS_HOST, 'redis');
  assert.equal(
    Object.keys(apiEnvironment).some((key) => key.toLowerCase().includes('sentinel')),
    false,
  );
  assert.equal(JSON.stringify(apiEnvironment).includes('26379'), false);

  const redisCommand = commandParts(config.services.redis.command);
  assertAppendOnly(redisCommand);
  assert.equal(flagValue(redisCommand, '--maxmemory-policy'), 'noeviction');
  assert.equal(flagValue(redisCommand, '--replica-announce-ip'), 'redis');
  assert.equal(flagValue(redisCommand, '--replica-announce-port'), '6379');

  const replicaCommand = commandParts(config.services['redis-replica'].command);
  assertAppendOnly(replicaCommand);
  const replicaOf = replicaCommand.indexOf('--replicaof');
  assert.notEqual(replicaOf, -1);
  assert.deepEqual(replicaCommand.slice(replicaOf, replicaOf + 3), ['--replicaof', 'redis', '6379']);
  assert.equal(flagValue(replicaCommand, '--replica-read-only'), 'yes');
  assert.equal(flagValue(replicaCommand, '--replica-priority'), '0');

  const sentinel = config.services['redis-sentinel'];
  assert.equal(sentinel.ports.length, 1);
  assert.equal(sentinel.ports[0].host_ip, '127.0.0.1');
  assert.equal(String(sentinel.ports[0].published), '26379');
  assert.equal(String(sentinel.ports[0].target), '26379');
  assert.deepEqual(sentinel.healthcheck.test, [
    'CMD',
    '/bin/sh',
    '/usr/local/bin/redis-sentinel-entrypoint.sh',
    'healthcheck',
  ]);

  const script = fs.readFileSync(path.join(root, 'deploy', 'redis', 'sentinel-entrypoint.sh'), 'utf8');
  assert.match(script, /SENTINEL MASTER redis/);
  assert.match(script, /sentinel monitor redis redis 6379 1/);
  assert.match(script, /num-slaves/);
  assert.match(script, /role-reported/);
  assert.equal(script.includes('redis-cli ping'), false);
});
