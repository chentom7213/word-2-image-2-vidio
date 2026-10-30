-- Explicit collaboration boundary for generated artifacts.  Existing work
-- remains private; sharing must always be an intentional opt-in.
SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'visibility');
SET @sql := IF(@has = 0,
  'ALTER TABLE `generation_tasks` ADD COLUMN `visibility` ENUM(''private'',''org'') NOT NULL DEFAULT ''private'' AFTER `org_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND INDEX_NAME = 'idx_task_org_visibility');
-- A migration can encounter an old half-built table.  The baseline will keep
-- filling it on subsequent repair migrations, so only add this optimization
-- when every indexed column actually exists.
SET @cols := ((SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'org_id') > 0
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'visibility') > 0
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'created_at') > 0);
SET @sql := IF(@has_idx = 0 AND @cols,
  'CREATE INDEX idx_task_org_visibility ON generation_tasks (org_id, visibility, created_at)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
