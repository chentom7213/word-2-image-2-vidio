-- Soft-close marker for account erasure.
--
-- Closing an account sets users.deleted_at and keeps the row. credit_transactions
-- and orders reference users with ON DELETE CASCADE, so deleting the user row
-- would erase the append-only ledger and payment history. A later purge job
-- removes that user's tasks, outputs, assets and sessions, then anonymizes the
-- same row. It never deletes the user.
--
-- Re-runnable: MySQL has no ADD COLUMN IF NOT EXISTS, so both changes are
-- guarded with information_schema. This file does not change foreign keys
-- and does not partition any table.

SET @has_deleted_at := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deleted_at'
);
SET @sql := IF(@has_deleted_at = 0,
  'ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_deleted_at'
);
SET @sql := IF(@has_idx = 0,
  'CREATE INDEX idx_users_deleted_at ON users (deleted_at)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
