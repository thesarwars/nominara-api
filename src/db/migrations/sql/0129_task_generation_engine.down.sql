-- Reverses 0129. The seeded catalog rows are removed only where no task references them (tasks.rule_code is a foreign
-- key); a rule that has produced work stays, so a rollback never orphans a task. The recurrence counter and the
-- re-enable watermark are lost on rollback.
DROP TRIGGER IF EXISTS stamp_enabled_since ON task_generation_rules;
DROP FUNCTION IF EXISTS app.task_generation_rules_stamp_enabled_since();
DELETE FROM task_generation_rules r
 WHERE r.rule_version = '2026.10.1'
   AND r.code LIKE 'TG-%'
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.rule_code = r.code);
ALTER TABLE task_generation_rules DROP COLUMN IF EXISTS enabled_since;
ALTER TABLE tasks DROP COLUMN IF EXISTS last_evidence_at, DROP COLUMN IF EXISTS recurrence_count;
