-- Rollback of 0176_geo_alignment_node_task_rule. Removes the rule only while no task was generated from it (a task keeps its rule code).
DELETE FROM task_generation_rules WHERE code = 'TG-ALIGNMENT-NODE'
 AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.rule_code = 'TG-ALIGNMENT-NODE');
