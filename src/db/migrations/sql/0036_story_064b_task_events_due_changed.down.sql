-- Rollback: rows carrying 'due_changed' would violate the narrower CHECK, so
-- they are removed first (derived timeline entries; the task row keeps due_at).
DELETE FROM task_events WHERE event = 'due_changed';
ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','status_changed','assigned','commented','priority_changed',
                   'goal_linked','completed','reopened','dismissed','evidence_refreshed'));
