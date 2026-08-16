-- STORY-013 — partition & vacuum maintenance, retention cascade, orphan scan.
-- Spec: data-model.md §5 partitioning, §7 retention/erasure, §8 vacuum.

-- ============================================================================
-- purge_failures — GLOBAL (src/db/conventions.ts GLOBAL_TABLES), same class
-- as engine_health: platform ops telemetry, not tenant data, written by a job
-- with no single tenant context. NFR-CMP-05 — src/db/purge-check.ts
-- (`pnpm db:purge-check`) asserts zero rows unresolved past 7 days.
-- ============================================================================
CREATE TABLE purge_failures (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text        NOT NULL CHECK (scope IN ('project','workspace')),
  scope_id    uuid        NOT NULL,
  reason      text        NOT NULL,
  detail      jsonb,
  failed_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid        REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_purge_failures_unresolved ON purge_failures (failed_at) WHERE resolved_at IS NULL;

-- ============================================================================
-- system actor row — STORY-011's SYSTEM_ACTOR_ID (src/tenancy/constants.ts)
-- is the all-zeros UUID, safe to use where a column carries NO foreign key
-- (audit_log.actor_id). task_events.actor_id, milestones.created_by, and
-- credit_ledger.actor_id all DO carry `REFERENCES users(id)` — reassigning
-- an erased individual's authored rows to SYSTEM_ACTOR_ID (data-model.md §7
-- "Individual erasure request") requires a real users row at that id to
-- satisfy those FKs. `.invalid` is the reserved TLD (RFC 2606) this
-- migration's own erasure convention already uses for anonymised emails.
-- ============================================================================
INSERT INTO users (id, email, full_name, status)
VALUES ('00000000-0000-0000-0000-000000000000', 'system@nominara.invalid', 'System', 'active')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Vacuum tuning — data-model.md §8. Verified live (not assumed): Postgres
-- rejects ANY storage parameter on a partitioned PARENT relation outright
-- ("cannot specify storage parameters for a partitioned table ... Specify
-- storage parameters for its leaf partitions instead") — there is no ALTER
-- TABLE this migration could run on answer_captures/mention_facts/
-- citation_facts themselves. Tuning is therefore applied to every EXISTING
-- leaf partition (the two migration 0003 already created) via the DO block
-- below; every partition src/workers/rollup/maintenance.ts creates from
-- this point forward re-applies the same parameters explicitly, every time.
-- ============================================================================
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
      EXECUTE format(
        'ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)',
        child
      );
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE metric_daily SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);

-- usage_counters/credit_wallets already carry fillfactor=70 plus the same
-- scale factors from migration 0002 — this adds the "dedicated aggressive
-- threshold" data-model.md §8 calls for but does not number (see this
-- story's Implementation Decisions section for the chosen value).
ALTER TABLE usage_counters SET (autovacuum_vacuum_threshold = 25, autovacuum_analyze_threshold = 25);
ALTER TABLE credit_wallets SET (autovacuum_vacuum_threshold = 25, autovacuum_analyze_threshold = 25);
