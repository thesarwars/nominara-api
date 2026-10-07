-- 0029_story_170_session_active_workspace: reverse of the up migration.
ALTER TABLE sessions DROP COLUMN IF EXISTS active_workspace_id;
