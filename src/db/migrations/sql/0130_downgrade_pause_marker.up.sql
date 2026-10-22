-- STORY-077 slice A — the downgrade-pause marker. Additive and nullable on existing tenant tables; expand phase.
--
-- plans-and-entitlements.md §14: at a downgrade's cut-over the most recently created excess projects and prompts are
-- PAUSED, never deleted, and (STORY-077 AC5) a downgrade pause must be distinguishable from a person's pause and must
-- resume automatically on a later upgrade. So the pause is recorded on the row itself:
--
--   paused_by_downgrade_at    when the cut-over paused the row; NULL for every other row, including a row a person
--                             paused. The CHECK ties it to status = 'paused' so no other status can carry it.
--   paused_by_downgrade_from  projects only: the status the pause took the project out of ('active' or
--                             'initializing'), so a resume puts back exactly that. A prompt is only ever paused from
--                             'active', so it needs none.
--
-- Existing RLS policies on projects and tracked_prompts cover the new columns; no policy changes.
--
-- ⚠ EVERY CHECK IS ADDED NOT VALID, and 0131 validates them in a file (a transaction) of its own, as 0085/0086 do.
-- projects and tracked_prompts are hot tenant tables: a validating ADD CONSTRAINT scans every row under ACCESS
-- EXCLUSIVE, blocking reads and writes for the whole scan. NOT VALID still enforces the CHECK on every new or updated
-- row from this migration on; VALIDATE takes only SHARE UPDATE EXCLUSIVE.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS paused_by_downgrade_at timestamptz,
  ADD COLUMN IF NOT EXISTS paused_by_downgrade_from text;

ALTER TABLE projects
  ADD CONSTRAINT ck_projects_paused_by_downgrade_from CHECK (paused_by_downgrade_from IN ('active', 'initializing')) NOT VALID;

ALTER TABLE projects
  ADD CONSTRAINT ck_projects_paused_by_downgrade CHECK (
    (paused_by_downgrade_at IS NULL AND paused_by_downgrade_from IS NULL)
    OR (paused_by_downgrade_at IS NOT NULL AND paused_by_downgrade_from IS NOT NULL AND status = 'paused')
  ) NOT VALID;

ALTER TABLE tracked_prompts
  ADD COLUMN IF NOT EXISTS paused_by_downgrade_at timestamptz;

ALTER TABLE tracked_prompts
  ADD CONSTRAINT ck_tracked_prompts_paused_by_downgrade CHECK (paused_by_downgrade_at IS NULL OR status = 'paused') NOT VALID;
