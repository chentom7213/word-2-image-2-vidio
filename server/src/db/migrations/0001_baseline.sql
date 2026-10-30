-- 0001_baseline.sql
--
-- The complete v1 schema **end state**: every table plus every additive
-- column/index that existed before versioned migrations were introduced.
--
-- Every statement is idempotent (CREATE TABLE IF NOT EXISTS, plus conditional
-- ALTERs guarded by information_schema), so this runs against an empty database
-- AND against one that already has these objects. That is what lets an existing
-- deployment be adopted without a rebuild.
--
-- Note: no `AFTER <column>` clauses on purpose. Column position is irrelevant to
-- correctness, and pinning it makes a migration depend on sibling columns
-- existing, which breaks on legacy tables with a different shape.
--
-- NEVER edit this file once it has shipped. All future schema changes go into a
-- new numbered file.

-- BenchU Canvas schema (MySQL 8+)
-- Charset utf8mb4 for full CJK/emoji support.
-- All statements are idempotent; column-level upgrades live in src/db/init.ts.

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(80)  NULL,
  credits       INT          NOT NULL DEFAULT 1000,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 模型注册表：价格/能力以 DB 为准，前端不再硬编码 ────────────────────
CREATE TABLE IF NOT EXISTS model_registry (
  id             VARCHAR(64)  NOT NULL PRIMARY KEY,
  provider       VARCHAR(64)  NOT NULL,
  display_name   VARCHAR(120) NOT NULL,
  kind           ENUM('image','video') NOT NULL,
  price_unit     ENUM('per_second','per_call','per_image') NOT NULL,
  price_amount   INT          NOT NULL,
  max_duration   INT          NULL,
  resolutions    JSON         NULL,
  capabilities   JSON         NULL,
  provider_model VARCHAR(120) NOT NULL,
  enabled        TINYINT(1)   NOT NULL DEFAULT 1,
  sort_weight    INT          NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_tasks (
  org_id      CHAR(36)     NULL,  -- tenant scope (nullable for legacy rows)
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  type         ENUM('image','video') NOT NULL,
  prompt       TEXT         NOT NULL,
  model_id     VARCHAR(64)  NOT NULL,
  model_name   VARCHAR(120) NOT NULL,
  resolution   VARCHAR(16)  NULL,
  width        INT          NOT NULL DEFAULT 0,
  height       INT          NOT NULL DEFAULT 0,
  duration     INT          NOT NULL DEFAULT 0,
  `count`      INT          NOT NULL DEFAULT 1,
  status       ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  progress     TINYINT      NOT NULL DEFAULT 0,
  seed         VARCHAR(80)  NOT NULL,
  result_url   VARCHAR(500) NULL,
  poster_url   VARCHAR(500) NULL,
  credits_cost INT          NOT NULL DEFAULT 0,
  cost_actual  INT          NOT NULL DEFAULT 0,
  error        VARCHAR(500) NULL,
  error_code   VARCHAR(40)  NULL,
  idempotency_key VARCHAR(80) NULL,
  priority     TINYINT      NOT NULL DEFAULT 5,
  attempts     TINYINT      NOT NULL DEFAULT 0,
  max_attempts TINYINT      NOT NULL DEFAULT 3,
  provider_job_id VARCHAR(120) NULL,
  started_at   DATETIME     NULL,
  finished_at  DATETIME     NULL,
  heartbeat_at DATETIME     NULL,
  refunded_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_task_idem (user_id, idempotency_key),
  KEY idx_task_user (user_id, created_at),
  KEY idx_task_pick (status, priority, created_at),
  KEY idx_task_running (status, heartbeat_at),
  CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 产物：1 任务 N 产物（4 张图 / 1 视频 + 封面）────────────────────────
CREATE TABLE IF NOT EXISTS task_outputs (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  task_id     CHAR(36)     NOT NULL,
  kind        ENUM('image','video','poster','sprite','audio','thumbnail') NOT NULL,
  object_key  VARCHAR(500) NOT NULL,
  mime        VARCHAR(80)  NOT NULL,
  width       INT          NULL,
  height      INT          NULL,
  duration    INT          NULL,
  bytes       BIGINT       NULL,
  sha256      CHAR(64)     NULL,
  watermarked TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_out_task (task_id, sort_order),
  CONSTRAINT fk_out_task FOREIGN KEY (task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assets (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  org_id     CHAR(36)     NULL,
  user_id    CHAR(36)     NOT NULL,
  filename   VARCHAR(255) NOT NULL,
  url        VARCHAR(500) NOT NULL,
  size       INT          NOT NULL DEFAULT 0,
  mime       VARCHAR(120) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_asset_user (user_id, created_at),
  CONSTRAINT fk_asset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_refs (
  task_id  CHAR(36) NOT NULL,
  asset_id CHAR(36) NOT NULL,
  kind     ENUM('image','video','audio') NOT NULL,
  PRIMARY KEY (task_id, asset_id),
  KEY idx_ref_task (task_id),
  CONSTRAINT fk_ref_task  FOREIGN KEY (task_id)  REFERENCES generation_tasks(id) ON DELETE CASCADE,
  CONSTRAINT fk_ref_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_transactions (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  user_id      CHAR(36)     NOT NULL,
  delta        INT          NOT NULL,
  balance_after INT         NOT NULL,
  reason       VARCHAR(120) NOT NULL,
  ref_id       CHAR(36)     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tx_user (user_id, created_at),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organizations (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  plan       ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  credits    BIGINT       NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS memberships (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  org_id     CHAR(36)     NOT NULL,
  user_id    CHAR(36)     NOT NULL,
  role       ENUM('owner','admin','editor','viewer') NOT NULL DEFAULT 'viewer',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_org_user (org_id, user_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_mem_org  FOREIGN KEY (org_id)  REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS api_keys (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  org_id      CHAR(36)     NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  key_prefix  VARCHAR(12)  NOT NULL,
  key_hash    CHAR(64)     NOT NULL,
  scopes      JSON         NOT NULL,
  rate_limit  INT          NOT NULL DEFAULT 60,
  expires_at  DATETIME     NULL,
  last_used_at DATETIME    NULL,
  revoked_at  DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key_hash (key_hash),
  KEY idx_key_org (org_id),
  CONSTRAINT fk_key_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_id     CHAR(36)   NULL,
  user_id    CHAR(36)   NULL,
  action     VARCHAR(80) NOT NULL,
  target     VARCHAR(120) NULL,
  ip         VARCHAR(45) NULL,
  ua         VARCHAR(300) NULL,
  meta       JSON       NULL,
  created_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_user (user_id, created_at),
  KEY idx_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 会话（refresh token 旋转）──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  family_id  CHAR(36)     NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME     NOT NULL,
  revoked_at DATETIME     NULL,
  replaced_by CHAR(36)    NULL,
  ip         VARCHAR(45)  NULL,
  user_agent VARCHAR(300) NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rt_hash (token_hash),
  KEY idx_rt_user (user_id, expires_at),
  KEY idx_rt_family (family_id),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Incremental columns (previously hand-applied by init.ts) ──────────

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'org_id');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `org_id` CHAR(36) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'idempotency_key');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `idempotency_key` VARCHAR(80) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'poster_url');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `poster_url` VARCHAR(500) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'error_code');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `error_code` VARCHAR(40) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'cost_actual');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `cost_actual` INT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'priority');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `priority` TINYINT NOT NULL DEFAULT 5', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'attempts');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `attempts` TINYINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'max_attempts');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `max_attempts` TINYINT NOT NULL DEFAULT 3', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'provider_job_id');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `provider_job_id` VARCHAR(120) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'started_at');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `started_at` DATETIME NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'finished_at');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `finished_at` DATETIME NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'heartbeat_at');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `heartbeat_at` DATETIME NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'refunded_at');
SET @sql := IF(@has = 0, 'ALTER TABLE `generation_tasks` ADD COLUMN `refunded_at` DATETIME NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND COLUMN_NAME = 'org_id');
SET @sql := IF(@has = 0, 'ALTER TABLE `assets` ADD COLUMN `org_id` CHAR(36) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'org_id');
SET @sql := IF(@has = 0, 'ALTER TABLE `audit_logs` ADD COLUMN `org_id` CHAR(36) NULL', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Incremental indexes ──────────────────────────────────────────────

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND INDEX_NAME = 'uk_task_idem');
SET @cols := ((SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'user_id') > 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'idempotency_key') > 0);
SET @sql := IF(@has = 0 AND @cols, 'ALTER TABLE `generation_tasks` ADD UNIQUE KEY uk_task_idem (user_id, idempotency_key)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND INDEX_NAME = 'idx_task_pick');
SET @cols := ((SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'status') > 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'priority') > 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'created_at') > 0);
SET @sql := IF(@has = 0 AND @cols, 'ALTER TABLE `generation_tasks` ADD KEY idx_task_pick (status, priority, created_at)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND INDEX_NAME = 'idx_task_running');
SET @cols := ((SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'status') > 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'heartbeat_at') > 0);
SET @sql := IF(@has = 0 AND @cols, 'ALTER TABLE `generation_tasks` ADD KEY idx_task_running (status, heartbeat_at)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
