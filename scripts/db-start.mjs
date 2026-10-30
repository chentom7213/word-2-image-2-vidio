#!/usr/bin/env node
/**
 * Starts the isolated MySQL dev instance (port 3307) used by this project.
 * It never touches the machine's existing MySQL service.
 *
 *   node scripts/db-start.mjs [--init]
 *
 * --init  also bootstraps the data directory + schema + demo account
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const MYSQLD = 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe';
const DATADIR = 'D:\\mysql-dev-data';
const PORT = 3307;

const log = (msg) => console.log(`[db] ${msg}`);

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

async function main() {
  if (await isPortOpen(PORT)) {
    log(`MySQL 已在 127.0.0.1:${PORT} 运行，跳过启动`);
    return;
  }

  if (!existsSync(MYSQLD)) {
    console.error(`[db] 找不到 mysqld：${MYSQLD}`);
    console.error('[db] 请修改 scripts/db-start.mjs 中的 MYSQLD 路径');
    process.exit(1);
  }

  if (!existsSync(join(DATADIR, 'mysql'))) {
    log(`初始化数据目录 ${DATADIR} …`);
    mkdirSync(DATADIR, { recursive: true });
    const init = spawnSync(MYSQLD, ['--no-defaults', `--datadir=${DATADIR}`, '--initialize-insecure'], {
      stdio: 'inherit',
    });
    if (init.status !== 0) {
      console.error('[db] 初始化失败');
      process.exit(1);
    }
  }

  log(`启动 mysqld，端口 ${PORT}（数据目录 ${DATADIR}）`);
  const child = spawn(
    MYSQLD,
    [
      '--no-defaults',
      `--datadir=${DATADIR}`,
      `--port=${PORT}`,
      '--bind-address=127.0.0.1',
      '--mysqlx=OFF',
      '--console',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  for (let i = 0; i < 40; i++) {
    if (await isPortOpen(PORT)) {
      log('MySQL 就绪 ✔');
      // give InnoDB a moment to finish recovery
      await new Promise((r) => setTimeout(r, 1200));
      if (process.argv.includes('--init')) {
        log('执行 db:init …');
        spawnSync('npm', ['--prefix', 'server', 'run', 'db:init'], { stdio: 'inherit', shell: true });
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('[db] 启动超时，请查看 D:\\mysql-dev-data\\*.err');
  process.exit(1);
}

void main();
