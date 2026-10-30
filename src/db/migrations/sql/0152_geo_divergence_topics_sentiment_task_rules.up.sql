-- STORY-061 - the task rules the A4 (divergence), A5 (topical authority) and A6 (sentiment drivers) findings name, so those findings
-- GENERATE tasks through the `geo_finding` condition (src/lib/taskgen/evaluate.ts), as 0150 did for A2 and A3.
--
-- Owner decision 20 (2026-10-30): the three rules are approved and ENABLED. The `enabled_since` trigger stamps the moment of enabling,
-- so no analysis row computed before this migration generates a task (the watermark every event rule uses is not retroactive).
--
--   TG-DIVERGENCE        RETARGETED from `pending_analysis` to `geo_finding` on the divergence analysis. The reference names this rule
--                        ("engine-targeted, naming the missing domain", scoring-models.md section 15). A finding exists only while
--                        project_divergence >= 0.45 over >= 10 qualifying prompts, and its id is `divergence-<engine>-<domain>`: one task
--                        per (losing engine, missing domain), never a generic one. Priority, impact, effort and cooldown are unchanged.
--   TG-TOPIC-CONTENT     RETARGETED the same way, on the topics analysis. A finding exists only for a topic in the top decile of
--                        gap_priority with achievability >= 0.5, and its headline carries the required concepts and the structure.
--   TG-SENTIMENT-REASON  NEW. One task per distinct negative reason class (`sentiment-reason-<reason>`), and a finding asks for a task only
--                        while negative_cell_rate has crossed 0.05 with n >= 30 (scoring-models.md section 6). It is NEW, not a retarget of
--                        TG-SENTIMENT-NEGATIVE, which stays a pending, disabled rule for negative_cell_rate (nothing maps to it any more:
--                        the `negative_spike` alert is raised through THIS rule, owner decision 21). `trigger_kind` is the existing CHECK
--                        member nearest the subject; the evaluator dispatches on the CONDITION kind. Priority 1, impact 0.85, effort m
--                        and cooldown 3 days are BUILDER READINGS copied from TG-SENTIMENT-NEGATIVE.
UPDATE task_generation_rules
   SET condition = '{"kind":"geo_finding","analysis":"divergence","finding_id_prefix":"divergence-"}',
       description_template = '{finding_headline}',
       rule_version = '2026.10.3',
       enabled = true
 WHERE code = 'TG-DIVERGENCE';

UPDATE task_generation_rules
   SET condition = '{"kind":"geo_finding","analysis":"topics","finding_id_prefix":"topic-gap-"}',
       description_template = '{finding_headline}',
       rule_version = '2026.10.3',
       enabled = true
 WHERE code = 'TG-TOPIC-CONTENT';

INSERT INTO task_generation_rules
  (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight,
   effort_band, opens_alignment, playbook_slug, cooldown_days, rule_version, enabled)
VALUES
  ('TG-SENTIMENT-REASON', 'content', 'Address a negative theme in how engines describe the brand',
   '{finding_headline}',
   'sentiment_negative', '{"kind":"geo_finding","analysis":"sentiment","finding_id_prefix":"sentiment-reason-"}',
   1, 0.85, 'm', false, NULL, 3, '2026.10.3', true)
ON CONFLICT (code) DO NOTHING;
