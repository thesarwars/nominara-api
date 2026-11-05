-- STORY-055 AC5/AC6/AC11, owner decision 30 (plans-7day/decisions-2026-10-28.md): a seeding task whose contribution URL has been
-- submitted but not yet verified is `in_review`. EXPAND phase: both CHECKs only widen, so every existing row still satisfies them
-- (written NOT VALID first, as 0030 and 0036 did; see the VALIDATE note below for what that does and does not buy).
--
-- WHERE THE URL AND THE REASON LIVE: no column is added. The submitted URL and the verification reason are `task_events` rows
-- (`verification_submitted` carries `{ "url": ... }`; `verification_failed` carries `{ "submission_id", "reason" }`), because they
-- are a history (a customer may resubmit after a failure) rather than one current value, and the timeline already shows it.
-- Their payload is validated by contracts/tasks/task-verification-payload.schema.ts.
--
-- `in_review` is OPEN (owner decision 30, builder reading): the gap is not closed until the URL verifies, so a task in review
-- counts everywhere a todo / in_progress task counts. `ix_tasks_open` is rebuilt over the three open statuses: a partial index is
-- used only when the query's predicate implies the index's, and every open-task query now names the three.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','in_review','done','dismissed')) NOT VALID;

ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','status_changed','assigned','commented','priority_changed',
                   'goal_linked','completed','reopened','dismissed','evidence_refreshed',
                   'due_changed','verification_submitted','verification_failed')) NOT VALID;

-- NOT VALID, then VALIDATE in a later statement - but in the SAME TRANSACTION: the migrate-runner wraps the whole file in one
-- transaction, so the ACCESS EXCLUSIVE lock the ADD took is held until COMMIT, the VALIDATE scan runs under it, and NOT VALID buys NO
-- lock relief here (the scan blocks reads and writes on `tasks` and `task_events` for its duration). The split is kept only so that
-- the constraint is checked rather than left NOT VALID (a NOT VALID constraint has not been checked against existing rows and is easy to
-- mistake for a checked one). It is acceptable because both CHECKs only WIDEN and the scan is one pass over each table; a table large enough
-- to make the scan matter would need the VALIDATE in a migration of its own (one transaction per file), which is the shape to use then.
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_status_check;
ALTER TABLE task_events VALIDATE CONSTRAINT task_events_event_check;

DROP INDEX ix_tasks_open;
CREATE INDEX ix_tasks_open ON tasks (workspace_id, impact_score DESC, priority DESC)
  WHERE status IN ('todo','in_progress','in_review') AND deleted_at IS NULL;
