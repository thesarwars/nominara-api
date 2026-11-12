-- STORY-066 AC9 / owner decision 99(e) (2026-11-12) - `tracked_prompts.status_changed_at`: when the prompt's status last changed.
--
-- `prompt_set_change` (scoring-models.md section 13) dates a prompt's REMOVAL from the set by the day it was archived. With no such
-- column the rollup used `updated_at`, which `touch_updated_at` bumps on ANY later update of the row, so an edit of an archived
-- prompt moved its "removed" day and a re-roll could pin a spurious change.
--
-- EXPAND-ONLY: one nullable column, no backfill, no default. NULL means "no status change recorded": every row that exists today
-- (the rollup falls back to `updated_at` for them, exactly as before), and a prompt inserted with its status and never changed. A
-- trigger stamps the column on every status change, from whichever writer (archive, pause, restore, the retention pause), so no
-- writer can forget. A statement that sets the column itself is left alone (a replay or a backfill keeps its own time).
ALTER TABLE tracked_prompts ADD COLUMN status_changed_at timestamptz;

COMMENT ON COLUMN tracked_prompts.status_changed_at IS
  'STORY-066 / decision 99(e): when `status` last changed (set by trigger). NULL = no change recorded; the rollup then reads updated_at. Dates a prompt''s removal from the prompt set (prompt_set_change).';

CREATE FUNCTION app.stamp_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status_changed_at IS NOT DISTINCT FROM OLD.status_changed_at THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_status_changed_at
  BEFORE UPDATE OF status ON tracked_prompts
  FOR EACH ROW EXECUTE FUNCTION app.stamp_status_changed_at();
