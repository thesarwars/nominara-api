-- STORY-064 (step B) — PATCH /v1/tasks/{id} writes an event for EVERY change,
-- including a due-date change, which the original vocabulary has no member for
-- (recording it as 'status_changed' would put a false entry in the timeline).
-- Additive: every existing value still satisfies the widened CHECK, so NOT VALID
-- (no scan under ACCESS EXCLUSIVE) is used, as in 0030.
-- Lane numbering: 0036 is this lane's range; the merge renumbers.
ALTER TABLE task_events DROP CONSTRAINT task_events_event_check;
ALTER TABLE task_events
  ADD CONSTRAINT task_events_event_check
  CHECK (event IN ('created','status_changed','assigned','commented','priority_changed',
                   'goal_linked','completed','reopened','dismissed','evidence_refreshed',
                   'due_changed')) NOT VALID;
