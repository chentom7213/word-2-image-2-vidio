-- Request id of the call that created the task.
--
-- Worker lines can then carry the same traceId as the HTTP access log.
-- Nullable so older rows stay valid. Re-runnable. This file does not change
-- foreign keys and does not partition any table.

SET @has_trace_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'trace_id'
);
SET @sql := IF(@has_trace_id = 0,
  'ALTER TABLE generation_tasks ADD COLUMN trace_id VARCHAR(64) NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
