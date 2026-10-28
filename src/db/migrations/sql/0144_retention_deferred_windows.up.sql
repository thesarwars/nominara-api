-- STORY-077 slice B review round 1 — while a retention-shortening deferral is in force (workspaces.retention_purge_not_before,
-- 0143) the workspace keeps the window it is moving AWAY from, instead of the sweep and the read paths treating the whole
-- workspace as exempt. These two columns hold that window: the longer of the replaced plan's window and any window already
-- being kept by an earlier deferral. NULL = never purged ("unlimited" or not applicable, the same encoding the sweep uses).
--
-- They mean something only while retention_purge_not_before is in the future; code ignores them otherwise. A deferral row with
-- both NULL (written before this migration) therefore keeps everything, the side that retains data. Expand only: two nullable
-- columns, nothing rewritten.
ALTER TABLE workspaces ADD COLUMN retention_deferred_raw_days integer;
ALTER TABLE workspaces ADD COLUMN retention_deferred_rollups_days integer;

COMMENT ON COLUMN workspaces.retention_deferred_raw_days IS
  'STORY-077 slice B — raw-capture window kept while retention_purge_not_before is in the future (the replaced plan''s). NULL = never purged.';
COMMENT ON COLUMN workspaces.retention_deferred_rollups_days IS
  'STORY-077 slice B — rollup window kept while retention_purge_not_before is in the future (the replaced plan''s). NULL = never purged.';
