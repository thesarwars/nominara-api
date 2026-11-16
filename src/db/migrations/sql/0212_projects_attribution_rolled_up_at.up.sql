-- STORY-114 AC6 / owner decision 107(c) - the per-project "last rollup committed" marker the attribution lag is measured against.
--
-- The lag objective (2 hours) runs from an ingested beacon session or citation to its appearance in the rollup, so a run needs to know
-- which rows no committed rollup has covered yet. attribution.rollup advances this column in the same transaction that writes the
-- rollup rows. NULL means no rollup has committed for the project; every ingested row is then pending.
--
-- Expand only: one nullable column on a table that already carries workspace_id and FORCE ROW LEVEL SECURITY, so no policy changes.
-- Backfilled from the newest rollup row so that the first run after this migration does not read old, already-rolled-up data as pending.
ALTER TABLE projects ADD COLUMN attribution_rolled_up_at timestamptz;

UPDATE projects p
   SET attribution_rolled_up_at = r.committed
  FROM (SELECT project_id, max(computed_at) AS committed FROM attribution_url_rollup GROUP BY project_id) r
 WHERE r.project_id = p.id;

COMMENT ON COLUMN projects.attribution_rolled_up_at IS
  'STORY-114 - when the last attribution.rollup for this project committed (the transaction start). Ingested rows after it are pending; the 2-hour lag objective is measured from the oldest of them.';
