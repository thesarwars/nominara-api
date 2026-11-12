-- STORY-066 rollback. The rollup then reads `updated_at` for the archive time again; the stamps are discarded with the column.
DROP TRIGGER IF EXISTS stamp_status_changed_at ON tracked_prompts;
DROP FUNCTION IF EXISTS app.stamp_status_changed_at();
ALTER TABLE tracked_prompts DROP COLUMN IF EXISTS status_changed_at;
