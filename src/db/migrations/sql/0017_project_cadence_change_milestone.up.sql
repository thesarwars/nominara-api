-- STORY-033 AC10 — a cadence change is recorded so a chart can annotate it.
--
-- scoring-models.md: "Cadence changes are annotated so a weekly->daily switch
-- does not read as a trend break." The annotation is not decoration. Doubling
-- the capture frequency changes the number of observations behind every daily
-- point, and an unannotated chart presents that as a movement in the thing
-- being measured rather than in how often it was measured.
--
-- WHY A TRIGGER RATHER THAN APPLICATION CODE. Two reasons, and the second is
-- the one that settles it:
--
--   Nothing writes `projects.cadence` yet — the projects module is still a
--   scaffold — so an application function would ship with no caller, and a
--   future caller can simply forget it. The annotation would then be missing
--   exactly when someone changed a cadence, which is the only time it matters.
--
--   The timestamp has to be the moment of the CHANGE. Anything that records
--   it later — a scheduler tick noticing a difference, a backfill — puts the
--   pin on the wrong date, and a pin on the wrong date is worse than none:
--   it explains the wrong trend break and leaves the real one unexplained.
--
-- A trigger cannot be forgotten by a caller and cannot be late.
--
-- INVOKER RIGHTS, DELIBERATELY. No SECURITY DEFINER, so the INSERT is subject
-- to the same RLS as any other write: it lands in the tenant's own workspace
-- or it fails, and it cannot be used to write a milestone into a workspace the
-- session could not otherwise reach.

CREATE OR REPLACE FUNCTION app.record_cadence_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, detail,
                          severity, source_type, visible_in_portal)
  VALUES (NEW.workspace_id, NEW.id, now(), 'annotation',
          'Capture cadence changed',
          format('%s to %s', OLD.cadence, NEW.cadence),
          'info', 'system', true);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.record_cadence_change() IS
  'STORY-033 AC10 — pins a cadence change on the Growth Map so a frequency change does not read as a trend break.';

-- `source_id` is left NULL on purpose. `ux_milestones_source` is unique over
-- (source_type, source_id) where source_id IS NOT NULL, so pinning the
-- project id there would let a project's cadence change exactly once and
-- raise a unique violation on the second — turning an annotation into a
-- constraint on the customer's settings.
--
-- UPDATE OF cadence narrows what is considered; the WHEN clause is what makes
-- it fire only on an actual change, since UPDATE OF fires whenever the column
-- appears in the statement even if the value is identical.
CREATE TRIGGER record_cadence_change
  AFTER UPDATE OF cadence ON projects
  FOR EACH ROW
  WHEN (OLD.cadence IS DISTINCT FROM NEW.cadence)
  EXECUTE FUNCTION app.record_cadence_change();
