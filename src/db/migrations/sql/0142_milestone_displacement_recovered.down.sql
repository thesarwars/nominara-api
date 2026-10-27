-- Undo 0142. A `displacement_recovered` row is kept, not deleted: it goes back to a manual-note
-- style `annotation` (its title still says what happened), as 0098's down did for its kind.
UPDATE milestones SET kind = 'annotation' WHERE kind = 'displacement_recovered';
ALTER TABLE milestones DROP CONSTRAINT milestones_kind_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_kind_check CHECK (kind IN
  ('task_completed','deployment','aux_status_change','schema_fixed',
   'source_seeded','competitor_added','competitor_removed','engine_model_change',
   'prompt_set_change','annotation'));
