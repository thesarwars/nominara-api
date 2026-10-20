-- Reverses 0129. The recurrence counter and the re-enable watermark are lost on rollback.
--
-- The two codes the dev demo seeder inserted before this engine existed (TG-SOV-DROP-ENGINE, TG-SOURCE-ABSENCE) may be rows
-- 0129 UPGRADED in place rather than rows it INSERTED, and the two cases cannot be told apart afterwards. They are therefore
-- never deleted: they are restored to the placeholder the seeder writes (empty condition, version 1.0.0, the column's default
-- cooldown). If 0129 had inserted them, what remains is exactly the row the demo seeder would have created, which no evaluator reads.
--
-- Every other seeded code is removed, but only where no task references it (tasks.rule_code is a foreign key): a rule that has
-- produced work stays, so a rollback never orphans a task.
DROP TRIGGER IF EXISTS stamp_enabled_since ON task_generation_rules;
DROP FUNCTION IF EXISTS app.task_generation_rules_stamp_enabled_since();
UPDATE task_generation_rules
   SET condition = '{}'::jsonb, cooldown_days = 14, rule_version = '1.0.0'
 WHERE code IN ('TG-SOV-DROP-ENGINE', 'TG-SOURCE-ABSENCE')
   AND rule_version = '2026.10.1';
DELETE FROM task_generation_rules r
 WHERE r.rule_version = '2026.10.1'
   AND r.code LIKE 'TG-%'
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.rule_code = r.code);
ALTER TABLE task_generation_rules DROP COLUMN IF EXISTS enabled_since;
ALTER TABLE tasks DROP COLUMN IF EXISTS last_evidence_at, DROP COLUMN IF EXISTS recurrence_count;

-- Restore what 0005's default privileges had granted to the runtime roles before 0129 narrowed it.
GRANT INSERT, UPDATE, DELETE ON task_generation_rules TO nominara_app, nominara_worker;
