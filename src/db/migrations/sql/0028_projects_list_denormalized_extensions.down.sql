-- 0028_projects_list_denormalized_extensions: reverse of the up migration.
--
-- All six columns are dropped. Nothing else references them yet (no FK, no
-- generated column, no RLS policy change — the table's existing
-- ws_isolation_projects policy covers every column), so this is a plain
-- drop with no ordering dependency.
ALTER TABLE projects DROP COLUMN IF EXISTS demo_seeded_at;
ALTER TABLE projects DROP COLUMN IF EXISTS open_tasks_by_severity;
ALTER TABLE projects DROP COLUMN IF EXISTS cells_30d;
ALTER TABLE projects DROP COLUMN IF EXISTS sentiment_delta_30d;
ALTER TABLE projects DROP COLUMN IF EXISTS sentiment_score;
ALTER TABLE projects DROP COLUMN IF EXISTS rendering_delta_30d;
