-- STORY-185 fix round (audit, major 1) - the scope an export was built for. EXPAND-ONLY: one nullable column, nothing existing is altered.
--
-- A second retention shortening inside a running deferral moves the purge cutoffs, so an export built for the first scope no longer covers everything
-- the purge will remove. `scope` records what each export was (or is being) built for: `{ purge_not_before, raw_cutoff, rollups_cutoff }` (ISO strings,
-- the cutoffs null when that window is not shortened). The request path and the retention notice reuse or link an export only when its scope EQUALS the
-- current one; otherwise it is superseded and a new build is allowed. A row with a null scope (made before this migration) never equals anything, so it is
-- superseded: the side that exports more.
ALTER TABLE retention_exports ADD COLUMN scope jsonb;

COMMENT ON COLUMN retention_exports.scope IS
  'STORY-185 fix round - { purge_not_before, raw_cutoff, rollups_cutoff } the export was built for; compared with the current scope to decide reuse. Null = legacy row = superseded.';
