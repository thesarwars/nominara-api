-- Reverses 0150. tasks.rule_code references the catalog, so a rule that already generated a task is kept (disabled) rather than deleted:
-- the task keeps its rule, and the rule stops generating.
DELETE FROM task_generation_rules r
 WHERE r.code IN ('TG-ENTITY-ALIAS', 'TG-STRUCTURE-TEMPLATE')
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.rule_code = r.code);
UPDATE task_generation_rules SET enabled = false WHERE code IN ('TG-ENTITY-ALIAS', 'TG-STRUCTURE-TEMPLATE');
