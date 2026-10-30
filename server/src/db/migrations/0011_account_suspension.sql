-- Suspension marker for severe content hits.
--
-- A severe hit sets users.suspended_at and keeps the row. Credits, orders and
-- the ledger stay. Re-runnable: MySQL has no ADD COLUMN IF NOT EXISTS, so both
-- changes are guarded with information_schema. This file does not change
-- foreign keys and does not partition any table.

SET @has_suspended_at := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'suspended_at'
);
SET @sql := IF(@has_suspended_at = 0,
  'ALTER TABLE users ADD COLUMN suspended_at DATETIME NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_suspended_at'
);
SET @sql := IF(@has_idx = 0,
  'CREATE INDEX idx_users_suspended_at ON users (suspended_at)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
