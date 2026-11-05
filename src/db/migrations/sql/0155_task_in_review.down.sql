-- Undo 0155. A task in review goes back to `in_progress`: its work was started and never verified, so it is still open and the
-- open count stays what it was (the same reading as a task a customer had begun). The verification events are the derived
-- history of the review state and cannot survive the narrower event CHECK, so they are removed first (as 0036's down removed
-- `due_changed`); the task rows keep everything else.
--
-- FORCE ROW LEVEL SECURITY: tasks and task_events are ENABLE + FORCE (0006) with their policies only TO nominara_app /
-- nominara_worker / ... In production nominara_owner (NOSUPERUSER, NOBYPASSRLS; README G-4) runs this file, and under FORCE even
-- the owner is subject to the policies, which it matches none of: the UPDATE and DELETE below would touch ZERO rows, and
-- re-adding the CHECKs would then fail on every leftover `in_review` row. (The local superuser bypasses RLS and hides it.) Same
-- pattern as 0124 / 0126 / 0142: FORCE is lifted for the rewrite and restored straight after, in this one transaction, so no other
-- session ever sees a table unforced; the DO block fails the file if FORCE is not back.
ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE task_events NO FORCE ROW LEVEL SECURITY;

DELETE FROM task_events WHERE event IN ('verification_submitted','verification_failed');
UPDATE tasks SET status = 'in_progress' WHERE status = 'in_review';

ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE task_events FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'tasks'::regclass)
     OR NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'task_events'::regclass) THEN
    RAISE EXCEPTION 'tasks and task_events must be FORCE ROW LEVEL SECURITY after the 0155 rollback';
  END IF;
END
$$;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','done','dismissed'));

ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','status_changed','assigned','commented','priority_changed',
                   'goal_linked','completed','reopened','dismissed','evidence_refreshed',
                   'due_changed'));

DROP INDEX ix_tasks_open;
CREATE INDEX ix_tasks_open ON tasks (workspace_id, impact_score DESC, priority DESC)
  WHERE status IN ('todo','in_progress') AND deleted_at IS NULL;
