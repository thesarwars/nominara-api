-- STORY-060 E7 / owner decision 99(b) (2026-11-12) - enable TG-ENTITY-NODE (and with it the `entity_node_missing` alert). DATA ONLY: one row in the global rule
-- catalog is retargeted, nothing is altered.
--
-- The profile probe (the `entity_probe` job) checks the Wikidata and Wikipedia profiles. A checked, ABSENT node of weight >= 0.18 (Wikidata, 0.22) now
-- makes the entity analysis write an `entity-node-missing-<node>` finding, and this rule turns that finding into one task, exactly as 0150 did for the alias
-- finding and 0152 for the divergence and topic findings. The alert is not a second mechanism: `entity_node_missing` (scoring-models.md section 15) is raised
-- from the task this rule generates (src/lib/alert-rules, `alertRuleForTask`), so the alert and the task cannot disagree.
--
--   TG-ENTITY-NODE   RETARGETED from `pending_analysis` (never evaluated) to `geo_finding` on the entity analysis, and ENABLED. The `enabled_since` trigger
--                    stamps the moment of enabling, so no analysis row computed before this migration generates a task (the watermark is not retroactive).
--                    The old title and description described an entity "absent from the brand's answers", which is not what this finding says; they are
--                    rewritten. Priority 3, impact weight 0.5, effort l and the 30-day cooldown are unchanged builder readings; `opens_alignment` stays as it was.
--
-- The other five authoritative nodes are not probed (decision 99b), so nothing here publishes an Entity Authority score: it still needs all seven nodes
-- checked and a model judge in force (STORY-191).
UPDATE task_generation_rules
   SET condition = '{"kind":"geo_finding","analysis":"entity","finding_id_prefix":"entity-node-missing-"}',
       title_template = 'Create the missing authoritative profile',
       description_template = '{finding_headline}',
       rule_version = '2026.11.1',
       enabled = true
 WHERE code = 'TG-ENTITY-NODE';
