-- Undo 0142. A `displacement_recovered` row is kept, not deleted: it goes back to a manual-note
-- style `annotation` (its title still says what happened), as 0098's down did for its kind.
--
-- FORCE ROW LEVEL SECURITY: milestones is ENABLE + FORCE (0006) with its policies only TO nominara_app / nominara_worker /
-- nominara_report / nominara_portal. In production nominara_owner (NOSUPERUSER, NOBYPASSRLS; README G-4) runs this file, and
-- under FORCE even the owner is subject to the policies, which it matches none of: the UPDATE below would touch ZERO rows,
-- and re-adding the CHECK would then fail on every leftover `displacement_recovered` row. (The local superuser bypasses RLS
-- and hides it.) Same pattern as 0124 / 0126: FORCE is lifted for the rewrite and restored straight after, in this one
-- transaction, so no other session ever sees the table unforced; the DO block fails the file if FORCE is not back.
ALTER TABLE milestones NO FORCE ROW LEVEL SECURITY;

UPDATE milestones SET kind = 'annotation' WHERE kind = 'displacement_recovered';

ALTER TABLE milestones FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'milestones'::regclass) THEN
    RAISE EXCEPTION 'milestones must be FORCE ROW LEVEL SECURITY after the 0142 rollback';
  END IF;
END
$$;

ALTER TABLE milestones DROP CONSTRAINT milestones_kind_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_kind_check CHECK (kind IN
  ('task_completed','deployment','aux_status_change','schema_fixed',
   'source_seeded','competitor_added','competitor_removed','engine_model_change',
   'prompt_set_change','annotation'));
