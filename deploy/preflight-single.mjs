#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEPLOY_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DEPLOY_DIR, '..');
const REQUIRED_SERVICES = ['mysql', 'redis', 'storage-init', 'migrate', 'api', 'web'];
const REQUIRED_VOLUMES = ['mysql-data', 'redis-data', 'app-storage'];
const SECRET_RULES = [
  ['MYSQL_ROOT_PASSWORD', 32],
  ['DB_PASSWORD', 32],
  ['JWT_SECRET', 32],
  ['STORAGE_SIGN_SECRET', 32],
  ['PAYMENT_WEBHOOK_SECRET', 32],
  ['METRICS_TOKEN', 32],
  ['SEED_PASSWORD', 16],
];

const HELP = `Usage: npm run deploy:preflight -- [options]

Options:
  --mode test|production  Validate the selected deployment policy (default: test)
  --env-file PATH         Compose environment file (default: .env)
  --offline               Skip daemon, port and live-health checks
  --json                  Emit machine-readable JSON only
  --help                  Show this help
`;

function result(code, status, message, hint) {
  return { code, status, message, ...(hint ? { hint } : {}) };
}

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { mode: 'test', envFile: path.resolve(cwd, '.env'), offline: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--mode') {
      const value = argv[++index];
      if (value !== 'test' && value !== 'production') throw new Error('--mode must be test or production');
      options.mode = value;
    } else if (arg === '--env-file') {
      const value = argv[++index];
      if (!value) throw new Error('--env-file requires a path');
      options.envFile = path.resolve(cwd, value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function isPlaceholder(value) {
  return (
    !value ||
    /SERVER_IP|replace[-_ ]|change[-_ ]?(me|before)|local[-_ ]?test|demo1234|rootpw|benchu_dev_pw/i.test(value)
  );
}

function durationSeconds(value) {
  if (typeof value !== 'string' || !value) return 0;
  let total = 0;
  let matched = '';
  for (const token of value.matchAll(/([0-9]+(?:\.[0-9]+)?)(h|m|s)/g)) {
    matched += token[0];
    total += Number(token[1]) * ({ h: 3600, m: 60, s: 1 }[token[2]] ?? 0);
  }
  return matched === value ? total : 0;
}

function memoryBytes(value) {
  if (typeof value === 'number') return value;
  const match = String(value ?? '')
    .trim()
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i);
  if (!match) return 0;
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = unit.startsWith('g')
    ? 1024 ** 3
    : unit.startsWith('m')
      ? 1024 ** 2
      : unit.startsWith('k')
        ? 1024
        : 1;
  return Number(match[1]) * multiplier;
}

function cleanOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publishedPorts(compose) {
  const found = [];
  for (const [service, config] of Object.entries(compose.services ?? {})) {
    for (const port of config.ports ?? []) {
      const published = Number(typeof port === 'object' ? port.published : String(port).split(':').at(-2));
      if (Number.isInteger(published)) found.push({ service, port: published });
    }
  }
  return found;
}

export function validateEffectiveConfig(
  compose,
  {
    mode = 'test',
    freeGb = 100,
    minFreeGb = 20,
    platform = process.platform,
    hostCpu = os.cpus().length,
    hostMemGb = os.totalmem() / 1024 ** 3,
  } = {},
) {
  const checks = [];
  const services = compose.services ?? {};
  const volumes = compose.volumes ?? {};
  const api = services.api ?? {};
  const apiEnv = api.environment ?? {};
  const mysqlEnv = services.mysql?.environment ?? {};
  const values = { ...apiEnv, MYSQL_ROOT_PASSWORD: mysqlEnv.MYSQL_ROOT_PASSWORD };

  for (const service of REQUIRED_SERVICES) {
    checks.push(
      services[service]
        ? result(`topology.service.${service}`, 'pass', `Compose service ${service} is present`)
        : result(`topology.service.${service}`, 'fail', `Compose service ${service} is missing`),
    );
  }
  for (const service of REQUIRED_SERVICES) {
    const config = services[service] ?? {};
    const bounded = Number(config.cpus) > 0 && memoryBytes(config.mem_limit) > 0 && Number(config.pids_limit) > 0;
    checks.push(
      bounded
        ? result(`resources.${service}`, 'pass', `${service} has CPU, memory and PID limits`)
        : result(`resources.${service}`, 'fail', `${service} must have positive CPU, memory and PID limits`),
    );
  }
  checks.push(
    memoryBytes(api.mem_limit) >= 1024 ** 3
      ? result('resources.api_memory', 'pass', 'API memory limit is at least 1 GiB')
      : result('resources.api_memory', 'fail', 'API memory limit must be at least 1 GiB for ffmpeg'),
    memoryBytes(services.mysql?.mem_limit) >= 768 * 1024 ** 2
      ? result('resources.mysql_memory', 'pass', 'MySQL memory limit is at least 768 MiB')
      : result('resources.mysql_memory', 'fail', 'MySQL memory limit must be at least 768 MiB'),
  );
  const redisCommand = Array.isArray(services.redis?.command)
    ? services.redis.command.map(String)
    : String(services.redis?.command ?? '').split(/\s+/);
  const maxMemoryIndex = redisCommand.indexOf('--maxmemory');
  const redisMaxMemory = memoryBytes(maxMemoryIndex >= 0 ? redisCommand[maxMemoryIndex + 1] : 0);
  const redisLimit = memoryBytes(services.redis?.mem_limit);
  checks.push(
    redisMaxMemory > 0 && redisLimit > 0 && redisMaxMemory <= redisLimit * 0.8
      ? result('resources.redis_memory', 'pass', 'Redis maxmemory leaves at least 20% process/AOF headroom')
      : result(
          'resources.redis_memory',
          'fail',
          'Redis maxmemory must be positive and no more than 80% of its container limit',
        ),
    redisCommand.includes('noeviction')
      ? result('resources.redis_policy', 'pass', 'Redis uses noeviction for durable queue signals')
      : result('resources.redis_policy', 'fail', 'Redis maxmemory policy must be noeviction'),
  );
  for (const volume of REQUIRED_VOLUMES) {
    checks.push(
      Object.hasOwn(volumes, volume)
        ? result(`topology.volume.${volume}`, 'pass', `Compose volume ${volume} is present`)
        : result(`topology.volume.${volume}`, 'fail', `Compose volume ${volume} is missing`),
    );
  }

  for (const [name, minLength] of SECRET_RULES) {
    const value = String(values[name] ?? '');
    if (isPlaceholder(value))
      checks.push(result(`secret.${name}`, 'fail', `${name} still uses an empty or placeholder value`));
    else if (value.length < minLength)
      checks.push(result(`secret.${name}`, 'fail', `${name} is shorter than ${minLength} characters`));
    else checks.push(result(`secret.${name}`, 'pass', `${name} is set`));
  }
  const independentSecrets = ['JWT_SECRET', 'STORAGE_SIGN_SECRET', 'PAYMENT_WEBHOOK_SECRET', 'METRICS_TOKEN']
    .map((name) => String(values[name] ?? ''))
    .filter(Boolean);
  checks.push(
    new Set(independentSecrets).size === independentSecrets.length
      ? result('secret.separation', 'pass', 'Signing and access secrets are distinct')
      : result('secret.separation', 'fail', 'Signing and access secrets must use distinct values'),
  );

  const publicOrigin = cleanOrigin(String(apiEnv.PUBLIC_BASE_URL ?? ''));
  const corsOrigins = String(apiEnv.CORS_ORIGIN ?? '')
    .split(',')
    .map((item) => cleanOrigin(item.trim()))
    .filter(Boolean);
  checks.push(
    publicOrigin && !isPlaceholder(String(apiEnv.PUBLIC_BASE_URL))
      ? result(
          'url.public',
          'pass',
          `PUBLIC_BASE_URL is a valid ${new URL(publicOrigin).protocol.replace(':', '')} origin`,
        )
      : result(
          'url.public',
          'fail',
          'PUBLIC_BASE_URL must be a concrete HTTP(S) origin without path/query credentials',
        ),
  );
  checks.push(
    publicOrigin && corsOrigins.includes(publicOrigin) && apiEnv.CORS_ORIGIN !== '*'
      ? result('url.cors', 'pass', 'CORS_ORIGIN includes PUBLIC_BASE_URL')
      : result('url.cors', 'fail', 'CORS_ORIGIN must explicitly include PUBLIC_BASE_URL'),
  );
  const secureCookie = String(apiEnv.REFRESH_COOKIE_SECURE) === 'true';
  if (publicOrigin?.startsWith('https://')) {
    checks.push(
      secureCookie
        ? result('cookie.secure', 'pass', 'Secure refresh cookies are enabled for HTTPS')
        : result('cookie.secure', 'fail', 'REFRESH_COOKIE_SECURE must be true for HTTPS'),
    );
  }

  if (mode === 'production') {
    checks.push(
      apiEnv.NODE_ENV === 'production'
        ? result('mode.node_env', 'pass', 'NODE_ENV is production')
        : result('mode.node_env', 'fail', 'Production mode requires NODE_ENV=production'),
      apiEnv.PAYMENT_PROVIDER !== 'mock'
        ? result('mode.payment', 'pass', 'A non-mock payment provider is selected')
        : result('mode.payment', 'fail', 'Production mode must not use mock payments'),
      publicOrigin?.startsWith('https://')
        ? result('mode.https', 'pass', 'Production public URL uses HTTPS')
        : result('mode.https', 'fail', 'Production mode requires an HTTPS PUBLIC_BASE_URL'),
      secureCookie
        ? result('mode.cookie', 'pass', 'Production refresh cookie is secure')
        : result('mode.cookie', 'fail', 'Production mode requires REFRESH_COOKIE_SECURE=true'),
    );
  } else {
    checks.push(
      apiEnv.NODE_ENV === 'development'
        ? result('mode.node_env', 'pass', 'Single-machine acceptance mode uses NODE_ENV=development')
        : result('mode.node_env', 'warn', 'Test mode normally uses NODE_ENV=development'),
      apiEnv.PAYMENT_PROVIDER === 'mock'
        ? result('mode.payment', 'pass', 'Single-machine acceptance mode uses mock payments')
        : result('mode.payment', 'warn', 'Test mode is configured with a live payment provider'),
    );
  }

  const invariants = [
    ['QUEUE_ENABLED', 'true'],
    ['EMBEDDED_WORKER', 'true'],
    ['STORAGE_DRIVER', 'local'],
    ['OUTPUT_DIR', '/app/storage'],
    ['DB_HOST', 'mysql'],
    ['REDIS_HOST', 'redis'],
    ['HOST', '0.0.0.0'],
  ];
  for (const [name, expected] of invariants) {
    checks.push(
      String(apiEnv[name]) === expected
        ? result(`invariant.${name}`, 'pass', `${name}=${expected}`)
        : result(`invariant.${name}`, 'fail', `${name} must be ${expected} for the single-machine topology`),
    );
  }

  for (const service of REQUIRED_SERVICES) {
    const options = services[service]?.logging?.options;
    checks.push(
      options?.['max-size'] && Number(options?.['max-file']) > 0
        ? result(`logging.${service}`, 'pass', `${service} log rotation is bounded`)
        : result(`logging.${service}`, 'fail', `${service} must configure max-size and max-file log rotation`),
    );
  }
  checks.push(
    durationSeconds(String(api.stop_grace_period ?? '')) >= 120
      ? result('runtime.stop_grace_period', 'pass', 'API stop grace period is at least 2 minutes')
      : result('runtime.stop_grace_period', 'fail', 'API stop grace period must be at least 2 minutes'),
  );

  const concurrency = Number(apiEnv.WORKER_CONCURRENCY);
  const ffmpegThreads = Number(apiEnv.FFMPEG_THREADS);
  const apiCpu = Number(api.cpus);
  checks.push(
    Number.isInteger(concurrency) && concurrency >= 1
      ? result(
          'runtime.worker_concurrency',
          concurrency > hostCpu ? 'warn' : 'pass',
          concurrency > hostCpu
            ? `WORKER_CONCURRENCY=${concurrency} exceeds detected CPU count ${hostCpu}`
            : `WORKER_CONCURRENCY=${concurrency}`,
        )
      : result('runtime.worker_concurrency', 'fail', 'WORKER_CONCURRENCY must be a positive integer'),
  );
  checks.push(
    Number.isInteger(ffmpegThreads) && ffmpegThreads >= 1
      ? result('runtime.ffmpeg_threads', 'pass', `FFMPEG_THREADS=${ffmpegThreads}`)
      : result('runtime.ffmpeg_threads', 'fail', 'FFMPEG_THREADS must be a positive integer'),
  );
  if (Number.isFinite(concurrency) && Number.isFinite(ffmpegThreads) && apiCpu > 0) {
    checks.push(
      concurrency > Math.ceil(apiCpu) || concurrency * ffmpegThreads > apiCpu * 2
        ? result(
            'runtime.render_budget',
            'warn',
            'Worker concurrency and ffmpeg threads exceed the recommended API CPU budget',
          )
        : result('runtime.render_budget', 'pass', 'Worker and ffmpeg thread counts fit the API CPU budget'),
    );
  }
  checks.push(
    Number(apiEnv.RBAC_MEMBERSHIP_CACHE_TTL_SECONDS) >= 0
      ? result('runtime.rbac_ttl', 'pass', 'RBAC cache TTL is non-negative')
      : result('runtime.rbac_ttl', 'fail', 'RBAC_MEMBERSHIP_CACHE_TTL_SECONDS must be non-negative'),
  );

  const ports = publishedPorts(compose);
  const portCounts = new Map();
  for (const entry of ports) portCounts.set(entry.port, (portCounts.get(entry.port) ?? 0) + 1);
  checks.push(
    ports.every(({ port }) => port >= 1 && port <= 65535) && [...portCounts.values()].every((count) => count === 1)
      ? result('network.ports', 'pass', 'Published ports are valid and distinct')
      : result('network.ports', 'fail', 'Published ports must be valid and distinct'),
  );

  checks.push(
    freeGb >= minFreeGb
      ? result('disk.free', 'pass', `${freeGb.toFixed(1)} GiB free on the deployment filesystem`)
      : result('disk.free', 'fail', `${freeGb.toFixed(1)} GiB free; at least ${minFreeGb} GiB is required`),
  );
  if (platform !== 'linux') {
    checks.push(
      result('disk.platform', 'warn', 'Host free space may differ from the Docker VM disk quota on this platform'),
    );
  }
  checks.push(
    hostCpu >= 2
      ? result('host.cpu', 'pass', `${hostCpu} logical CPUs detected`)
      : result('host.cpu', 'fail', 'At least 2 logical CPUs are required'),
    hostMemGb >= 4
      ? result('host.memory', hostMemGb < 8 ? 'warn' : 'pass', `${hostMemGb.toFixed(1)} GiB host memory detected`)
      : result('host.memory', 'fail', 'At least 4 GiB host memory is required'),
  );
  return checks;
}

export function parseComposePs(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export function checkPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function command(args, timeout = 15_000) {
  const execution = spawnSync('docker', args, { cwd: REPO_ROOT, encoding: 'utf8', shell: false, timeout });
  return { ok: execution.status === 0, stdout: execution.stdout ?? '', stderr: execution.stderr ?? '' };
}

function composeArgs(envFile, args) {
  return ['compose', '--env-file', envFile, ...args];
}

function freeSpaceGb(target) {
  const stats = statfsSync(target);
  return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
}

function runtimeChecks(ps) {
  const checks = [];
  const byService = new Map(ps.map((item) => [item.Service, item]));
  for (const service of ['mysql', 'redis', 'api', 'web']) {
    const item = byService.get(service);
    const healthy = !item?.Health || item.Health === 'healthy';
    checks.push(
      item?.State === 'running' && healthy
        ? result(`live.${service}`, 'pass', `${service} is running${item.Health ? ' and healthy' : ''}`)
        : result(`live.${service}`, 'fail', `${service} is not running and healthy`),
    );
  }
  for (const service of ['storage-init', 'migrate']) {
    const item = byService.get(service);
    checks.push(
      item?.State === 'exited' && Number(item.ExitCode) === 0
        ? result(`live.${service}`, 'pass', `${service} completed successfully`)
        : result(`live.${service}`, 'fail', `${service} has not completed successfully`),
    );
  }
  return checks;
}

export async function runPreflight(options) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(
    nodeMajor >= 22
      ? result('tool.node', 'pass', `Node.js ${process.versions.node}`)
      : result('tool.node', 'fail', `Node.js 22 or newer is required; found ${process.versions.node}`),
  );
  checks.push(
    existsSync(options.envFile)
      ? result('config.env_file', 'pass', `Environment file found: ${path.basename(options.envFile)}`)
      : result('config.env_file', 'fail', `Environment file not found: ${options.envFile}`),
  );

  const dockerCli = command(['--version']);
  checks.push(
    dockerCli.ok
      ? result('tool.docker', 'pass', dockerCli.stdout.trim())
      : result('tool.docker', 'fail', 'Docker CLI is not available'),
  );
  const composeVersion = command(['compose', 'version']);
  checks.push(
    composeVersion.ok
      ? result('tool.compose', 'pass', composeVersion.stdout.trim())
      : result('tool.compose', 'fail', 'Docker Compose v2 is not available'),
  );

  let daemonAvailable = false;
  if (!options.offline && dockerCli.ok) {
    const daemon = command(['info', '--format', '{{.ServerVersion}}']);
    daemonAvailable = daemon.ok;
    checks.push(
      daemon.ok
        ? result('tool.daemon', 'pass', `Docker daemon ${daemon.stdout.trim()} is reachable`)
        : result('tool.daemon', 'fail', 'Docker daemon is not reachable'),
    );
  } else if (options.offline) checks.push(result('tool.daemon', 'warn', 'Docker daemon check skipped in offline mode'));

  let compose;
  if (composeVersion.ok && existsSync(options.envFile)) {
    const rendered = command(composeArgs(options.envFile, ['config', '--format', 'json']));
    if (rendered.ok) {
      try {
        compose = JSON.parse(rendered.stdout);
        checks.push(result('config.compose', 'pass', 'Effective Compose configuration rendered successfully'));
      } catch {
        checks.push(result('config.compose', 'fail', 'Compose returned malformed JSON'));
      }
    } else checks.push(result('config.compose', 'fail', 'Docker Compose configuration is invalid'));
  }

  const minFreeGb = Number(process.env.PREFLIGHT_MIN_FREE_GB ?? 20);
  let freeGb = 0;
  try {
    freeGb = freeSpaceGb(REPO_ROOT);
  } catch {
    checks.push(result('disk.free', 'fail', 'Unable to read free disk space'));
  }
  if (compose) checks.push(...validateEffectiveConfig(compose, { mode: options.mode, freeGb, minFreeGb }));

  try {
    accessSync(REPO_ROOT, constants.W_OK);
    checks.push(result('backup.destination', 'pass', 'Repository directory is writable for the default backups path'));
    checks.push(result('backup.offsite', 'warn', 'Keep a second backup copy on another disk or remote host'));
  } catch {
    checks.push(result('backup.destination', 'fail', 'Repository directory is not writable for backups'));
  }

  if (!options.offline && daemonAvailable && compose) {
    const listed = command(composeArgs(options.envFile, ['ps', '--all', '--format', 'json']));
    let ps = [];
    if (listed.ok) {
      try {
        ps = parseComposePs(listed.stdout);
      } catch {
        checks.push(result('live.compose_ps', 'fail', 'Unable to parse Docker Compose service state'));
      }
    }
    if (ps.length > 0) {
      checks.push(...runtimeChecks(ps));
      const publicUrl = compose.services.api?.environment?.PUBLIC_BASE_URL;
      try {
        const response = await fetch(`${String(publicUrl).replace(/\/$/, '')}/api/ready`, {
          signal: AbortSignal.timeout(5_000),
        });
        checks.push(
          response.ok
            ? result('live.ready', 'pass', 'Public /api/ready endpoint is healthy')
            : result('live.ready', 'fail', `Public /api/ready returned HTTP ${response.status}`),
        );
      } catch {
        checks.push(result('live.ready', 'fail', 'Public /api/ready endpoint is unreachable'));
      }
    } else {
      const ports = publishedPorts(compose);
      for (const { service, port } of ports) {
        const host = service === 'web' ? '0.0.0.0' : '127.0.0.1';
        const available = await checkPort(host, port);
        checks.push(
          available
            ? result(`port.${service}`, 'pass', `${host}:${port} is available`)
            : result(`port.${service}`, 'fail', `${host}:${port} is already in use`),
        );
      }
    }
  }
  return checks;
}

function printChecks(checks, json) {
  const summary = {
    pass: checks.filter((item) => item.status === 'pass').length,
    warn: checks.filter((item) => item.status === 'warn').length,
    fail: checks.filter((item) => item.status === 'fail').length,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: summary.fail === 0, summary, checks }, null, 2)}\n`);
    return;
  }
  for (const check of checks) {
    const marker = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }[check.status];
    console.log(`[${marker}] ${check.message}`);
    if (check.hint) console.log(`       ${check.hint}`);
  }
  console.log(`\nPreflight: ${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), REPO_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    const checks = await runPreflight(options);
    printChecks(checks, options.json);
    if (checks.some((item) => item.status === 'fail')) process.exitCode = 1;
  } catch (error) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: 'preflight-internal-error' })}\n`);
    else console.error('Preflight internal error:', error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
