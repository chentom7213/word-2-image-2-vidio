-- Cold archive for audit_logs.
--
-- Columns, primary key and secondary indexes match the hot table (including
-- idx_audit_org from 0002). There are no foreign keys: this is a detached
-- copy, and the hot business tables keep the foreign keys that protect
-- payments, credit ledger rows and generation tasks.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS is a no-op when the table exists.
-- This file does not partition any table and does not alter audit_logs.

CREATE TABLE IF NOT EXISTS audit_logs_archive (
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
  KEY idx_audit_action (action, created_at),
  KEY idx_audit_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
