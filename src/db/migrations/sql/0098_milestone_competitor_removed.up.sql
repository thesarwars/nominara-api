-- CP2 c-comp, owner decision (8): a competitor removal is its own milestone kind.
-- Removals used to reuse `competitor_added` under a title that said "removed", which
-- made the growth map's marker kind lie about what changed. EXPAND phase: the CHECK
-- only widens, so every existing row still satisfies it.
ALTER TABLE milestones DROP CONSTRAINT milestones_kind_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_kind_check CHECK (kind IN
  ('task_completed','deployment','aux_status_change','schema_fixed',
   'source_seeded','competitor_added','competitor_removed','engine_model_change',
   'prompt_set_change','annotation'));
