-- STORY-013 — rollback of 0007_partition_maintenance_and_retention.

ALTER TABLE credit_wallets  RESET (autovacuum_vacuum_threshold, autovacuum_analyze_threshold);
ALTER TABLE usage_counters  RESET (autovacuum_vacuum_threshold, autovacuum_analyze_threshold);

ALTER TABLE metric_daily RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);

-- Storage parameters cannot be set (or reset) on a partitioned PARENT
-- relation at all — see 0007.up.sql's own comment. Reset on every existing
-- leaf partition instead.
DO $$
DECLARE
  child regclass;
  fact_table text;
BEGIN
  FOREACH fact_table IN ARRAY ARRAY['answer_captures', 'mention_facts', 'citation_facts']
  LOOP
    FOR child IN
      SELECT c.oid::regclass
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = fact_table AND c.relkind = 'r'
    LOOP
      EXECUTE format('ALTER TABLE %s RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor)', child);
    END LOOP;
  END LOOP;
END $$;

-- KNOWN ROLLBACK LIMITATION (disclosed, not fixed — code review should-fix
-- #10): this DELETE fails with a foreign-key violation if ANY
-- credit_ledger.actor_id / milestones.created_by / task_events.actor_id row
-- has already been reassigned to this system-actor id by
-- requestIndividualErasure (src/workers/rollup/retention.ts) in a real
-- environment where an erasure actually ran. A fresh/empty shadow database
-- (pnpm migrate:check's own environment) never exercises that path, so this
-- passes there every time; it is a real landmine on a rollback attempted
-- against a database that has processed even one individual erasure. No
-- general, safe "reassign back to the original actor" exists — the original
-- actor id is exactly what erasure discarded. Not resolved here; disclosed
-- as a known rollback limitation (README.md "Disclosed gaps (STORY-013)").
DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000000';

DROP TABLE IF EXISTS purge_failures;
