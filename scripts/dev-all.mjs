#!/usr/bin/env node
/**
 * One-command dev stack: MySQL (3307) → API (4000) → Vite (5183).
 *
 *   npm run dev:all
 *
 * Ctrl+C stops the API and Vite. The MySQL instance is left running
 * (use `--stop-db` semantics manually if you want it gone).
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const ROOT = process.cwd();
const procs = [];

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(600, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) {
      log(label, `就绪 (127.0.0.1:${port}) ✔`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  log(label, `等待 ${port} 超时`);
  return false;
}

function run(tag, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const prefix = `[${tag}] `;
  child.stdout?.on('data', (b) => process.stdout.write(String(b).replace(/^/gm, prefix)));
  child.stderr?.on('data', (b) => process.stderr.write(String(b).replace(/^/gm, prefix)));
  child.on('exit', (code) => log(tag, `退出 code=${code}`));
  procs.push(child);
  return child;
}

function shutdown() {
  log('stack', '正在停止…');
  for (const p of procs) {
    try {
      if (process.platform === 'win32' && p.pid) {
        spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        p.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

async function main() {
  if (!(await isPortOpen(3307))) {
    log('db', '启动 MySQL (3307) …');
    run('db', 'node', ['scripts/db-start.mjs']);
    if (!(await waitForPort(3307, 'db'))) process.exit(1);
  } else {
    log('db', 'MySQL 已在运行 ✔');
  }

  if (!(await isPortOpen(4000))) {
    log('api', '启动 API (4000) …');
    run('api', 'npm', ['--prefix', 'server', 'run', 'dev']);
    if (!(await waitForPort(4000, 'api'))) process.exit(1);
  } else {
    log('api', 'API 已在运行 ✔');
  }

  log('web', '启动前端 (5183) …');
  run('web', 'npm', ['run', 'dev']);
  await waitForPort(5183, 'web');

  console.log('');
  console.log('  ────────────────────────────────────────────────');
  console.log('   前端   http://127.0.0.1:5183/video');
  console.log('   API    http://127.0.0.1:4000/api/health');
  console.log('   数据库  mysql://benchu@127.0.0.1:3307/benchu_canvas');
  console.log('   账号   demo@benchu.art / demo1234');
  console.log('  ────────────────────────────────────────────────');
  console.log('');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  shutdown();
});
