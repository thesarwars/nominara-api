-- STORY-195 AC4 — the free retry of an all-degraded first run. A retry run records WHICH run it retries, and the partial unique index below
-- is the limit: a run can be retried once, and two concurrent requests cannot both succeed (the loser meets 23505, never a second run).
-- Additive: a nullable column and an index; no existing row changes. capture_runs is already a tenant table (workspace_id, RLS), so no
-- policy changes. ON DELETE SET NULL: the retry run outlives a purged original as an ordinary run.
ALTER TABLE capture_runs
  ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES capture_runs (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_capture_runs_retry_of ON capture_runs (retry_of) WHERE retry_of IS NOT NULL;

COMMENT ON COLUMN capture_runs.retry_of IS
  'STORY-195 AC4 — the run this one is the free retry of; NULL for every other run. At most one retry per run (ux_capture_runs_retry_of).';
