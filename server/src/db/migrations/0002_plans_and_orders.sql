-- 0002_plans_and_orders.sql
--
-- Adds the commercial layer: plans, credit packs, orders, payment events, and
-- the user columns that record current entitlement.
--
-- Written to be safe on BOTH a fresh database (created by 0001) and an
-- existing one, because every statement is guarded:
--   * tables use CREATE TABLE IF NOT EXISTS
--   * columns are added conditionally via a prepared statement
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, so the guard is done with
-- information_schema + PREPARE. That keeps the file re-runnable, which is what
-- makes `db:migrate` safe to call on every deploy.
--
-- REVISION NOTE (pre-release): this file was amended before any customer
-- environment applied it, to inherit the `users` collation for the orders FK.
-- Once a migration has shipped, amend it by adding a NEW file instead — the
-- runner rejects edited checksums on purpose.

-- ── 套餐（定价与配额的服务端权威源）────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              VARCHAR(32)  NOT NULL PRIMARY KEY,
  name            VARCHAR(80)  NOT NULL,
  price_cents     INT          NOT NULL DEFAULT 0,
  monthly_credits INT          NULL,
  max_concurrent  INT          NOT NULL DEFAULT 1,
  max_duration    INT          NOT NULL DEFAULT 10,
  rpm             INT          NOT NULL DEFAULT 30,
  features        JSON         NULL,
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  sort_weight     INT          NOT NULL DEFAULT 0,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS credit_packs (
  id          VARCHAR(32) NOT NULL PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  credits     INT         NOT NULL,
  price_cents INT         NOT NULL,
  bonus       INT         NOT NULL DEFAULT 0,
  enabled     TINYINT(1)  NOT NULL DEFAULT 1,
  sort_weight INT         NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 订单 ──────────────────────────────────────────────────────────────
-- Collation is inherited from `users` rather than hard-coded: `orders.user_id`
-- has a foreign key to `users.id`, and MySQL requires both sides to match.
-- A legacy database created without an explicit collation defaults to
-- utf8mb4_0900_ai_ci on MySQL 8, so pinning utf8mb4_unicode_ci here would make
-- the FK creation fail with ER_FK_COLLATION_CHANGE_NOT_SUPPORTED.
SET @users_collation := COALESCE(
  (SELECT TABLE_COLLATION FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'),
  'utf8mb4_unicode_ci'
);

SET @sql := CONCAT(
  'CREATE TABLE IF NOT EXISTS orders (
    id                CHAR(36)    NOT NULL PRIMARY KEY,
    org_id            CHAR(36)    NULL,
    user_id           CHAR(36)    NOT NULL,
    kind              ENUM(''plan'',''credits'') NOT NULL,
    sku_id            VARCHAR(32) NOT NULL,
    sku_name          VARCHAR(80) NOT NULL,
    amount_cents      INT         NOT NULL,
    credits           INT         NOT NULL,
    status            ENUM(''pending'',''paid'',''failed'',''refunded'',''expired'') NOT NULL DEFAULT ''pending'',
    provider          VARCHAR(32) NULL,
    provider_order_id VARCHAR(120) NULL,
    idempotency_key   VARCHAR(80) NULL,
    provider_txn_id   VARCHAR(120) NULL,
    paid_at           DATETIME    NULL,
    expires_at        DATETIME    NOT NULL,
    created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_order_idem (user_id, idempotency_key),
    UNIQUE KEY uk_order_provider (provider, provider_order_id),
    KEY idx_order_user (user_id, created_at),
    KEY idx_order_status (status, created_at),
    CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=', @users_collation
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 支付回调事件（幂等去重）─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_events (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  provider   VARCHAR(32)  NOT NULL,
  event_id   VARCHAR(120) NOT NULL,
  order_id   CHAR(36)     NULL,
  event_type VARCHAR(40)  NOT NULL,
  payload    JSON         NULL,
  outcome    VARCHAR(20)  NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_provider_event (provider, event_id),
  KEY idx_pe_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── users：当前权益 ───────────────────────────────────────────────────
SET @has_plan_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan_id'
);
SET @sql := IF(@has_plan_id = 0,
  'ALTER TABLE users ADD COLUMN plan_id VARCHAR(32) NOT NULL DEFAULT ''free'' AFTER credits',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_plan_exp := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan_expires_at'
);
SET @sql := IF(@has_plan_exp = 0,
  'ALTER TABLE users ADD COLUMN plan_expires_at DATETIME NULL AFTER plan_id',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 审计：按 org 检索（多租户合规）──────────────────────────────────────
-- Guarded because MySQL has no `CREATE INDEX IF NOT EXISTS`; an unguarded
-- statement here would break re-running the whole file after a partial failure.
SET @has_idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_org');
SET @sql := IF(@has_idx = 0,
  'CREATE INDEX idx_audit_org ON audit_logs (org_id, created_at)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
