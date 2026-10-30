import { readFileSync, writeFileSync } from 'node:fs';

/*
 * Regenerates src/db/migrations/0001_baseline.sql as the v1 end state.
 *
 * Two deliberate choices, both learned from a failing drill:
 *   1. No `AFTER <column>` in the ADD COLUMNs. Column position is irrelevant to
 *      correctness, and `AFTER error` made every migration depend on a sibling
 *      column existing — which breaks on any legacy table with a different shape.
 *   2. Every ALTER is guarded via information_schema, so the file is re-runnable
 *      after a partial failure (MySQL DDL is not transactional).
 */

const src = readFileSync('src/db/schema.sql', 'utf8');
const lines = src.split('\n');

// The commercial layer belongs to 0002, not the baseline.
const COMMERCIAL = ['plans', 'credit_packs', 'orders', 'payment_events'];
let skipping = false;
const kept = [];

for (const line of lines) {
  const create = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(line);
  if (create && COMMERCIAL.includes(create[1])) skipping = true;
  if (skipping && /^\) ENGINE=/.test(line)) {
    skipping = false;
    continue;
  }
  if (/^-- ── (套餐|充值包|订单|支付回调事件)/.test(line)) continue;
  if (/^-- 金额与积分数一律从/.test(line)) continue;
  if (/^-- 绝不接受客户端传入的价格/.test(line)) continue;
  if (/^-- 网关侧事件唯一 ID/.test(line)) continue;
  if (/^-- 同一事件重复投递只处理一次/.test(line)) continue;
  if (/^-- 'processed' \| 'duplicate'/.test(line)) continue;
  if (skipping) continue;
  kept.push(line);
}

/** Conditional ADD COLUMN — MySQL has no native `IF NOT EXISTS`. */
function addColumn(table, column, ddl) {
  return `SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}');
SET @sql := IF(@has = 0, 'ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;`;
}

/**
 * Conditional index creation.
 *
 * Guarded on BOTH the index not existing AND every referenced column being
 * present. Without the column check, adopting a database whose table has a
 * different shape fails with "Key column doesn't exist" and blocks the whole
 * rollout — a much worse outcome than skipping an optimization index.
 */
function addIndex(table, indexName, definition, columns) {
  const colChecks = columns
    .map(
      (c) => `(SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${c}') > 0`,
    )
    .join(' AND ');
  return `SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND INDEX_NAME = '${indexName}');
SET @cols := (${colChecks});
SET @sql := IF(@has = 0 AND @cols, 'ALTER TABLE \`${table}\` ADD ${definition}', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;`;
}

const columns = [
  ['generation_tasks', 'org_id', 'CHAR(36) NULL'],
  ['generation_tasks', 'idempotency_key', 'VARCHAR(80) NULL'],
  ['generation_tasks', 'poster_url', 'VARCHAR(500) NULL'],
  ['generation_tasks', 'error_code', 'VARCHAR(40) NULL'],
  ['generation_tasks', 'cost_actual', 'INT NOT NULL DEFAULT 0'],
  ['generation_tasks', 'priority', 'TINYINT NOT NULL DEFAULT 5'],
  ['generation_tasks', 'attempts', 'TINYINT NOT NULL DEFAULT 0'],
  ['generation_tasks', 'max_attempts', 'TINYINT NOT NULL DEFAULT 3'],
  ['generation_tasks', 'provider_job_id', 'VARCHAR(120) NULL'],
  ['generation_tasks', 'started_at', 'DATETIME NULL'],
  ['generation_tasks', 'finished_at', 'DATETIME NULL'],
  ['generation_tasks', 'heartbeat_at', 'DATETIME NULL'],
  ['generation_tasks', 'refunded_at', 'DATETIME NULL'],
  ['assets', 'org_id', 'CHAR(36) NULL'],
  ['audit_logs', 'org_id', 'CHAR(36) NULL'],
];

const indexes = [
  ['generation_tasks', 'uk_task_idem', 'UNIQUE KEY uk_task_idem (user_id, idempotency_key)', ['user_id', 'idempotency_key']],
  ['generation_tasks', 'idx_task_pick', 'KEY idx_task_pick (status, priority, created_at)', ['status', 'priority', 'created_at']],
  ['generation_tasks', 'idx_task_running', 'KEY idx_task_running (status, heartbeat_at)', ['status', 'heartbeat_at']],
];

const header = `-- 0001_baseline.sql
--
-- The complete v1 schema **end state**: every table plus every additive
-- column/index that existed before versioned migrations were introduced.
--
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS, plus conditional
-- ALTERs guarded by information_schema), so this runs against an empty database
-- AND against one that already has these objects. That is what lets an existing
-- deployment be adopted without a rebuild.
--
-- Note: no \`AFTER <column>\` clauses on purpose. Column position is irrelevant to
-- correctness, and pinning it makes a migration depend on sibling columns
-- existing, which breaks on legacy tables with a different shape.
--
-- NEVER edit this file once it has shipped. All future schema changes go into a
-- new numbered file.

`;

const body = kept.join('\n').replace(/\n{3,}/g, '\n\n');
const colBlock = `\n-- ── Incremental columns (previously hand-applied by init.ts) ──────────\n\n${columns
  .map(([t, c, d]) => addColumn(t, c, d))
  .join('\n\n')}\n`;
const idxBlock = `\n-- ── Incremental indexes ──────────────────────────────────────────────\n\n${indexes
  .map(([t, n, d, cols]) => addIndex(t, n, d, cols))
  .join('\n\n')}\n`;

writeFileSync('src/db/migrations/0001_baseline.sql', header + body + colBlock + idxBlock, 'utf8');

const out = readFileSync('src/db/migrations/0001_baseline.sql', 'utf8');
const tables = [...out.matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]);
console.log('tables:', tables.join(', '));
console.log('AFTER clauses:', (out.match(/ AFTER /g) ?? []).length);
console.log('bytes:', out.length);
