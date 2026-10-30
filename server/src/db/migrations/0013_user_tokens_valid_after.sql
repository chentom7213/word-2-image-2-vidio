-- Cutoff for access tokens issued before "log out everywhere" or a suspension.
--
-- Nullable so existing users stay valid. Re-runnable. This file does not change
-- foreign keys and does not partition any table.

SET @has_tokens_valid_after := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'tokens_valid_after'
);
SET @sql := IF(@has_tokens_valid_after = 0,
  'ALTER TABLE users ADD COLUMN tokens_valid_after DATETIME(3) NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
