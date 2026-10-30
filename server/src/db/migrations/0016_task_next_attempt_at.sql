-- Remember when a retryable task may be queued again.
--
-- The in-memory delay is lost if the worker exits. Boot recovery and the
-- idle reconciler must not republish the row before this timestamp.
-- Re-runnable. This file does not change foreign keys and does not partition.

SET @has_next_attempt := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'generation_tasks' AND COLUMN_NAME = 'next_attempt_at'
);
SET @sql := IF(@has_next_attempt = 0,
  'ALTER TABLE generation_tasks ADD COLUMN next_attempt_at DATETIME(3) NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
