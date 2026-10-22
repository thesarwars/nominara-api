-- Drops the downgrade-pause marker. Lossy: a project or prompt a downgrade paused stays paused, but can no longer be
-- told apart from one a person paused, so a later upgrade will not resume it automatically. Roll back only when no
-- row carries the marker (SELECT count(*) FROM projects WHERE paused_by_downgrade_at IS NOT NULL, and the same on
-- tracked_prompts), or resume those rows by hand first.
ALTER TABLE tracked_prompts DROP CONSTRAINT IF EXISTS ck_tracked_prompts_paused_by_downgrade;
ALTER TABLE tracked_prompts DROP COLUMN IF EXISTS paused_by_downgrade_at;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_paused_by_downgrade;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects_paused_by_downgrade_from;
ALTER TABLE projects DROP COLUMN IF EXISTS paused_by_downgrade_from;
ALTER TABLE projects DROP COLUMN IF EXISTS paused_by_downgrade_at;
