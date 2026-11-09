-- 0176_geo_alignment_node_task_rule: STORY-192. The A1 (alignment) findings are written to geo_analyses through STORY-062's layer, and a finding must
-- terminate in a task rule or an explicit no-action verdict (FR-GEO-01). The rule below is the one an alignment finding names.
--
-- SEEDED DISABLED, as TG-ENTITY-NODE and the other pending rules were: nothing generates a task from an alignment finding until the owner decides to
-- (priority, impact, effort and cooldown are BUILDER READINGS copied from TG-TOPIC-CONTENT, the nearest content rule, and the condition is a placeholder
-- like theirs). `opens_alignment` is true, so a content task of this rule will carry an alignment-session reference when the task engine consumes it.
-- ON CONFLICT leaves a row ops already tuned.
INSERT INTO task_generation_rules
  (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight,
   effort_band, opens_alignment, playbook_slug, cooldown_days, rule_version, enabled)
VALUES
  ('TG-ALIGNMENT-NODE', 'content', 'A concept engines cite is missing from the page',
   '{finding_headline}',
   'topic_gap', '{"kind":"pending_analysis","analysis":"alignment_node"}', 4, 0.45, 'l', true, NULL, 30, '2026.11.1', false)
ON CONFLICT (code) DO NOTHING;
