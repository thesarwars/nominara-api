-- STORY-063 — the task generation engine. Expand phase: two nullable/defaulted columns on `tasks`, one nullable watermark
-- on the global rule catalog, one trigger, and the catalog itself as seeded data. Nothing is dropped or tightened.
--
-- tasks.recurrence_count / tasks.last_evidence_at: "recurrence refreshes evidence and bumps a counter"
-- (schemas/tasks-and-goals.md). The counter is a column rather than a count of `evidence_refreshed` events because the
-- queue and its badges read it on every list. `last_evidence_at` is the end of the latest evaluated metric day the task
-- was built or refreshed from; a recurrence only counts when its evidence is NEWER, so re-running the same rollup (the
-- rollup re-runs on dirty dates) can never inflate the counter. It is NOT a wall-clock time.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_count integer NOT NULL DEFAULT 0 CHECK (recurrence_count >= 0),
  ADD COLUMN IF NOT EXISTS last_evidence_at timestamptz;

-- task_generation_rules.enabled_since: the non-retroactive re-enable watermark. NULL means "evaluated since always"
-- (a rule that has never been switched off). A false -> true flip stamps it with now(), and the evaluator skips any
-- metric day before the workspace-local date of that moment, so re-enabling a rule does not generate for the period it
-- was off. A TRIGGER stamps it, not application code, because the catalog is tuned by a plain row UPDATE with no deploy.
ALTER TABLE task_generation_rules ADD COLUMN IF NOT EXISTS enabled_since timestamptz;

CREATE OR REPLACE FUNCTION app.task_generation_rules_stamp_enabled_since()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A rule INSERTed enabled starts evaluating from now, not from the beginning of history.
    IF NEW.enabled AND NEW.enabled_since IS NULL THEN
      NEW.enabled_since := now();
    END IF;
  ELSIF NEW.enabled AND NOT OLD.enabled THEN
    NEW.enabled_since := now();
  END IF;
  RETURN NEW;
END
$$;

-- The catalog (scoring-models.md §15, "Generates" column). Versioned data: tune any row with an UPDATE. The condition is a
-- closed predicate template (contracts/tasks/task-generation.schema.ts), never SQL text.
--
-- ON CONFLICT: an existing row is left exactly as ops tuned it, EXCEPT a row whose condition is still the empty
-- placeholder the dev demo seeder inserted before this engine existed — that one is upgraded to the real condition, cooldown
-- and version. Its trigger_kind, category and templates are deliberately NOT overwritten: for the two codes the seeder
-- inserted (TG-SOV-DROP-ENGINE, TG-SOURCE-ABSENCE) they already agree, and wording belongs to whoever tuned it.
--
-- Rules whose facts need an analysis that has not shipped (topic gap, divergence, entity node, rendering downgrade, and
-- the negative-sentiment alert, whose `negative_cell_rate` needs a negative-cell count metric_daily does not hold) are
-- seeded DISABLED with a `pending_analysis` condition: enabling one early generates nothing. The alert is NOT approximated
-- with mentions_negative / mentions_total, which is a different formula (scoring-models.md §6).
--
-- Every metric_window rule carries `sustained_days` 3: the change must also hold on 3 individual days of the 7-day window, so
-- a single bad day cannot carry the aggregate.
INSERT INTO task_generation_rules
  (code, category, title_template, description_template, trigger_kind, condition, default_priority, impact_weight,
   effort_band, opens_alignment, playbook_slug, cooldown_days, rule_version, enabled)
VALUES
  ('TG-SOV-DROP-ENGINE', 'monitoring', 'Share of voice dropped on {engine}',
   'Share of voice on {engine} fell {change_pct}% over the last {window_days} days against the {window_days} days before.',
   'sov_drop',
   '{"kind":"metric_window","metric":"sov","direction":"down","change":"relative","threshold":0.15,"window_days":7,"min_n":30,"sustained_days":3,"engine_scope":"each_engine"}',
   2, 0.8, 'm', false, NULL, 7, '2026.10.1', true),
  ('TG-SOV-DROP-GLOBAL', 'monitoring', 'Share of voice dropped across {engine_count} engines',
   'Share of voice fell by at least {change_pct}% over the last {window_days} days on {engine_count} engines at once.',
   'sov_drop',
   '{"kind":"metric_window","metric":"sov","direction":"down","change":"relative","threshold":0.15,"window_days":7,"min_n":30,"sustained_days":3,"engine_scope":"across_engines","min_engines":3}',
   1, 0.9, 'l', false, NULL, 7, '2026.10.1', true),
  ('TG-PRESENCE-LOSS', 'content', 'Brand presence fell on {engine}',
   'The share of answers on {engine} that mention the brand fell by {change_pct} points over the last {window_days} days.',
   'presence_loss',
   '{"kind":"metric_window","metric":"presence_rate","direction":"down","change":"absolute","threshold":0.1,"window_days":7,"min_n":30,"sustained_days":3,"engine_scope":"each_engine"}',
   2, 0.7, 'm', false, NULL, 7, '2026.10.1', true),
  ('TG-SENTIMENT-NEGATIVE', 'content', 'Negative mentions rose on {engine}',
   'The share of answers on {engine} with a negative brand mention rose by {change_pct} points over the last {window_days} days.',
   'sentiment_negative',
   '{"kind":"pending_analysis","analysis":"negative_cell_rate"}',
   1, 0.85, 'm', false, NULL, 3, '2026.10.1', false),
  ('TG-CITATION-LOSS', 'authority', 'Owned citations fell on {engine}',
   'Citations of the brand''s own pages on {engine} fell by {change_pct}% over the last {window_days} days.',
   'citation_gap',
   '{"kind":"metric_window","metric":"owned_citation_count","direction":"down","change":"relative","threshold":0.25,"window_days":7,"min_n":30,"sustained_days":3,"engine_scope":"each_engine"}',
   2, 0.65, 'l', false, NULL, 7, '2026.10.1', true),
  ('TG-COMPETITOR-GAIN', 'content', 'A competitor overtook the brand',
   'A tracked competitor''s Visibility Score moved above the brand''s over the last {window_days} days.',
   'competitor_gain',
   '{"kind":"competitor_overtake","window_days":7,"min_n":30}',
   3, 0.6, 'l', false, NULL, 14, '2026.10.1', true),
  ('TG-SOURCE-ABSENCE', 'authority', 'Seed {domain} as a citable source',
   '{domain} is a seedable source with a critical citation gap for this project.',
   'source_absence',
   '{"kind":"source_gap","gap_severities":["critical"]}',
   3, 0.6, 'l', false, NULL, 30, '2026.10.1', true),
  ('TG-DISPLACEMENT-RECOVER', 'authority', 'Earn a citation on {domain}',
   'A high-impact displacement was detected; {domain} is a seedable source the brand is not cited on.',
   'displacement',
   '{"kind":"displacement","min_impact":60}',
   1, 1.0, 'm', false, NULL, 0, '2026.10.1', true),
  ('TG-PROMPT-UNSTABLE', 'monitoring', 'Priority prompts are unstable',
   '{prompt_count} priority prompts have a stability score under {max_stability}; their results vary too much between captures to trust a trend.',
   'prompt_unstable',
   '{"kind":"prompt_stability","max_stability":0.4,"min_prompts":5}',
   4, 0.3, 's', false, NULL, 14, '2026.10.1', true),
  ('TG-AUX-R-001', 'technical', 'Fix: {finding_title}', 'A critical crawler-access finding ({aux_rule_code}) was detected on the site.',
   'aux_finding', '{"kind":"aux_finding","aux_rule_code":"AUX-R-001","severities":["critical"]}', 2, 0.9, 's', false, NULL, 0, '2026.10.1', true),
  ('TG-AUX-R-002', 'technical', 'Fix: {finding_title}', 'A critical crawler-access finding ({aux_rule_code}) was detected on the site.',
   'aux_finding', '{"kind":"aux_finding","aux_rule_code":"AUX-R-002","severities":["critical"]}', 2, 0.9, 's', false, NULL, 0, '2026.10.1', true),
  ('TG-AUX-R-003', 'technical', 'Fix: {finding_title}', 'A critical crawler-access finding ({aux_rule_code}) was detected on the site.',
   'aux_finding', '{"kind":"aux_finding","aux_rule_code":"AUX-R-003","severities":["critical"]}', 2, 0.9, 's', false, NULL, 0, '2026.10.1', true),
  ('TG-AUX-R-004', 'technical', 'Fix: {finding_title}', 'A critical crawler-access finding ({aux_rule_code}) was detected on the site.',
   'aux_finding', '{"kind":"aux_finding","aux_rule_code":"AUX-R-004","severities":["critical"]}', 2, 0.9, 's', false, NULL, 0, '2026.10.1', true),
  ('TG-AUX-R-007', 'technical', 'Fix: {finding_title}', 'A critical crawler-access finding ({aux_rule_code}) was detected on the site.',
   'aux_finding', '{"kind":"aux_finding","aux_rule_code":"AUX-R-007","severities":["critical"]}', 2, 0.9, 's', false, NULL, 0, '2026.10.1', true),
  ('TG-RENDER-SCHEMA', 'technical', 'Rendering quality dropped',
   'Rendering quality fell, or price and rating were lost on a quarter of mentions.',
   'render_downgrade', '{"kind":"pending_analysis","analysis":"render_downgrade"}', 3, 0.6, 'm', false, NULL, 7, '2026.10.1', false),
  ('TG-ENTITY-NODE', 'content', 'A key entity node is missing from answers',
   'An entity the engines associate with the category is absent from the brand''s answers.',
   'entity_node', '{"kind":"pending_analysis","analysis":"entity_node"}', 3, 0.5, 'l', true, NULL, 30, '2026.10.1', false),
  ('TG-DIVERGENCE', 'authority', 'Engines disagree about the brand',
   'Cross-engine divergence is high; one engine is missing a domain the others cite.',
   'divergence', '{"kind":"pending_analysis","analysis":"divergence"}', 3, 0.55, 'l', false, NULL, 14, '2026.10.1', false),
  ('TG-TOPIC-CONTENT', 'content', 'A high-priority topic has no content',
   'A topic with a high gap priority and good achievability has no covering content.',
   'topic_gap', '{"kind":"pending_analysis","analysis":"topic_gap"}', 4, 0.45, 'l', true, NULL, 30, '2026.10.1', false)
ON CONFLICT (code) DO UPDATE
   SET condition = EXCLUDED.condition,
       cooldown_days = EXCLUDED.cooldown_days,
       rule_version = EXCLUDED.rule_version
 WHERE task_generation_rules.condition = '{}'::jsonb;

-- Created AFTER the seed above on purpose: the shipped catalog is "evaluated since always" (enabled_since NULL), while a rule an
-- operator INSERTs later, or flips from disabled to enabled, only reaches forward from that moment.
CREATE TRIGGER stamp_enabled_since BEFORE INSERT OR UPDATE OF enabled ON task_generation_rules
  FOR EACH ROW EXECUTE FUNCTION app.task_generation_rules_stamp_enabled_since();

-- The catalog is now LIVE CONFIGURATION that every tenant's worker trusts: its title and description templates are rendered into
-- every workspace's task titles, `enabled` switches a rule off everywhere, and the thresholds decide who gets a task. It is a
-- global table with no RLS, and 0005's default privileges gave the runtime roles INSERT/UPDATE/DELETE on it back when nothing read
-- it. Any write primitive under a tenant role (an injection elsewhere, a compromised worker) could therefore rewrite the text shown
-- to all tenants. The closed condition grammar protects the SQL, not the templates, `enabled` or `cooldown_days`.
-- So the runtime roles read it and nothing else; the migrator and ops roles tune it (the same shape as 0027 for
-- project_entitled_engines).
REVOKE INSERT, UPDATE, DELETE ON task_generation_rules FROM nominara_app, nominara_worker;
