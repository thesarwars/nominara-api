-- STORY-056 AC9, owner decision 2026-10-27 (item 2): a displacement recovery that follows a
-- completed task pins its own milestone kind, `displacement_recovered`. Labelling it an
-- `annotation` would make the marker kind misdescribe the event (the reasoning 0098 applied to
-- competitor_removed). EXPAND phase: the CHECK only widens, so every existing row still satisfies it.
ALTER TABLE milestones DROP CONSTRAINT milestones_kind_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_kind_check CHECK (kind IN
  ('task_completed','deployment','aux_status_change','schema_fixed',
   'source_seeded','competitor_added','competitor_removed','displacement_recovered',
   'engine_model_change','prompt_set_change','annotation'));
