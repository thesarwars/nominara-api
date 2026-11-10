-- STORY-195 — rollback of 0195_capture_runs_retry_of.
DROP INDEX IF EXISTS ux_capture_runs_retry_of;
ALTER TABLE capture_runs DROP COLUMN IF EXISTS retry_of;
