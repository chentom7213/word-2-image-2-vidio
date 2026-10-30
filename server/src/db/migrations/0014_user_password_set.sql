-- Local password flag for enterprise SSO accounts.
--
-- Existing rows stay at 1, so password login and password change keep requiring
-- the current password. A newly created SSO-only user is inserted with 0.
-- Re-runnable. This file does not change foreign keys and does not partition.

SET @has_password_set := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_set'
);
SET @sql := IF(@has_password_set = 0,
  'ALTER TABLE users ADD COLUMN password_set TINYINT(1) NOT NULL DEFAULT 1',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
