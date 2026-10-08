-- Undo 0098. A `competitor_removed` row is kept, not deleted: it goes back to the
-- kind it carried before (`competitor_added`, whose title still says "removed").
UPDATE milestones SET kind = 'competitor_added' WHERE kind = 'competitor_removed';
ALTER TABLE milestones DROP CONSTRAINT milestones_kind_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_kind_check CHECK (kind IN
  ('task_completed','deployment','aux_status_change','schema_fixed',
   'source_seeded','competitor_added','engine_model_change',
   'prompt_set_change','annotation'));
