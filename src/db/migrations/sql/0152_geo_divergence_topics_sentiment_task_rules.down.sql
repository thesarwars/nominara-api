-- Reverses 0152. tasks.rule_code references the catalog, so a new rule that already generated a task is kept (disabled).
UPDATE task_generation_rules
   SET condition = '{"kind":"pending_analysis","analysis":"divergence"}',
       description_template = 'Cross-engine divergence is high; one engine is missing a domain the others cite.',
       rule_version = '2026.10.1'
 WHERE code = 'TG-DIVERGENCE';
UPDATE task_generation_rules
   SET condition = '{"kind":"pending_analysis","analysis":"topic_gap"}',
       description_template = 'A topic with a high gap priority and good achievability has no covering content.',
       rule_version = '2026.10.1'
 WHERE code = 'TG-TOPIC-CONTENT';
DELETE FROM task_generation_rules r
 WHERE r.code = 'TG-SENTIMENT-REASON'
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.rule_code = r.code);
UPDATE task_generation_rules SET enabled = false WHERE code = 'TG-SENTIMENT-REASON';
