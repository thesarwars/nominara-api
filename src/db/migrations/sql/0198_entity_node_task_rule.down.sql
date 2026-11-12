-- Reverses 0198. tasks.rule_code references the catalog, so the row stays (disabled, as it was) and a task it already generated is kept.
UPDATE task_generation_rules
   SET condition = '{"kind":"pending_analysis","analysis":"entity_node"}',
       title_template = 'A key entity node is missing from answers',
       description_template = 'An entity the engines associate with the category is absent from the brand''s answers.',
       rule_version = '2026.10.1',
       enabled = false
 WHERE code = 'TG-ENTITY-NODE';
