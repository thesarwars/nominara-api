-- STORY-169 — six columns `GET /v1/projects` needs and `projects` does not
-- yet have. api-specification.md §3's contract for the workspace matrix adds
-- rendering_delta_30d, sentiment_score, sentiment_delta_30d, an open task
-- severity breakdown, the cell count the confidence band reads, and a demo
-- marker. All six are additive; none replaces or narrows an existing column.
--
--   rendering_delta_30d   numeric(6,3)  -- same window/threshold rule as
--                                          visibility_delta_30d, over the
--                                          'all' brand row's rendering_quality
--   sentiment_score       numeric(6,3)  -- latest day's 'all' brand
--                                          sentiment_score, same scale as
--                                          metric_daily (scoring-models.md §6)
--   sentiment_delta_30d   numeric(6,3)  -- window-mean delta, same rule as
--                                          visibility_delta_30d
--   cells_30d             integer       -- the current window's summed
--                                          cells_total, so confidenceFor() has
--                                          something to read at request time
--                                          without a second query over
--                                          metric_daily
--   open_tasks_by_severity jsonb        -- {critical,high,medium,low} counts
--                                          of open tasks; NOT NULL because
--                                          "no tasks yet" and "no producer
--                                          yet" are both honestly zero here —
--                                          unlike a score, a count has no
--                                          absent state
--   demo_seeded_at         timestamptz  -- set only by the dev-only demo
--                                          seed; NULL on every real project
ALTER TABLE projects ADD COLUMN rendering_delta_30d numeric(6,3);
ALTER TABLE projects ADD COLUMN sentiment_score numeric(6,3);
ALTER TABLE projects ADD COLUMN sentiment_delta_30d numeric(6,3);
ALTER TABLE projects ADD COLUMN cells_30d integer;

-- `ADD COLUMN … NOT NULL DEFAULT` matches additive-guard.ts's
-- `add column … not null` pattern, and unlike 0022's credit_ledger.attempt —
-- empty in every environment at the time it shipped — `projects` already has
-- rows in every real environment this migration will reach. The step is
-- genuinely additive: PG 18 stores a constant DEFAULT as a catalog value
-- rather than rewriting existing rows, so every already-existing project
-- gets the honest "zero open tasks of each severity" reading rather than a
-- backfill pass. The annotation says so explicitly instead of relying on
-- `isPopulated` happening to read false, which it will not here.
-- @contract-phase
ALTER TABLE projects ADD COLUMN open_tasks_by_severity jsonb NOT NULL
  DEFAULT '{"critical":0,"high":0,"medium":0,"low":0}'::jsonb;

ALTER TABLE projects ADD COLUMN demo_seeded_at timestamptz;

COMMENT ON COLUMN projects.rendering_delta_30d IS
  'Current 30d window mean minus prior 30d window mean of the ''all'' brand rendering_quality. NULL unless both windows have data — same rule as visibility_delta_30d.';
COMMENT ON COLUMN projects.sentiment_score IS
  'Latest day''s ''all'' brand sentiment_score (0-100, scoring-models.md §6). NULL when the day had no mentions, never 50.';
COMMENT ON COLUMN projects.sentiment_delta_30d IS
  'Window mean difference, same windows/threshold rule as visibility_delta_30d. NULL unless both windows have >=30 cells.';
COMMENT ON COLUMN projects.cells_30d IS
  'Summed cells_total of the current 30d window''s ''all'' brand rows — what confidenceFor() classifies at read time. NULL when the project has no rolled-up day.';
COMMENT ON COLUMN projects.open_tasks_by_severity IS
  'Counts of open (todo/in_progress, not deleted) tasks by derived severity. Tasks with no derivable severity count only in open_task_count, never here.';
COMMENT ON COLUMN projects.demo_seeded_at IS
  'Set only by the dev-only demo seed (STORY-169). NULL on every project the real pipeline produced.';
