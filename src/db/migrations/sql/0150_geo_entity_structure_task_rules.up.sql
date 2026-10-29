-- STORY-060 — owner decision 15 (plans-7day/decisions-2026-10-28.md): the two task rules the A2 and A3 findings name,
-- seeded so those findings generate tasks. Expand only: two rows in the global rule catalog, nothing altered.
--
--   TG-ENTITY-ALIAS       A2: high disambiguation risk suppresses the Entity Authority score and surfaces this task
--                         (aux-and-geo-analysis.md, FR-GEO-A2; STORY-060 AC6, scenario 4).
--   TG-STRUCTURE-TEMPLATE A3: the structure-match gap generates a structural task with its template (FR-GEO-A3c; scenario 8).
--
-- Both read `geo_analyses` through the `geo_finding` condition (src/lib/taskgen/evaluate.ts): the finding's `task_rule_code` is the
-- rule's code and its id starts with `finding_id_prefix`. The task is stamped `source_geo_analysis`, which is how the digest's lever
-- finds it. `trigger_kind` is the existing CHECK member nearest the subject (`entity_node`, `schema_missing`): the CHECK is not
-- widened here, and the evaluator dispatches on the CONDITION kind, never on this column.
--
-- Priority, impact weight, effort and cooldown are BUILDER READINGS (the reference names the tasks, not their numbers); the cooldown
-- matches TG-ENTITY-NODE and TG-TOPIC-CONTENT (30 days). Tune any row with an UPDATE. ON CONFLICT leaves a row ops already tuned.
INSERT INTO task_generation_rules
  (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight,
   effort_band, opens_alignment, playbook_slug, cooldown_days, rule_version, enabled)
VALUES
  ('TG-ENTITY-ALIAS', 'content', 'Tune the brand''s aliases and negative aliases',
   '{finding_headline}',
   'entity_node', '{"kind":"geo_finding","analysis":"entity","finding_id_prefix":"entity-alias-tuning"}',
   2, 0.6, 's', false, NULL, 30, '2026.10.2', true),
  ('TG-STRUCTURE-TEMPLATE', 'content', 'Give the page the structure the answers use',
   '{finding_headline}',
   'schema_missing', '{"kind":"geo_finding","analysis":"structure","finding_id_prefix":"structure-gap-"}',
   3, 0.4, 'm', false, NULL, 30, '2026.10.2', true)
ON CONFLICT (code) DO NOTHING;
