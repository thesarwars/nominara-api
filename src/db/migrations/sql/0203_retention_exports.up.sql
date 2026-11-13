-- STORY-185 / owner decision 100(a),(c) (2026-11-12) - the full-data export offered before a retention purge. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- While a retention-shortening deferral is pending (`workspaces.retention_purge_not_before` ahead of now) an owner or admin may request ONE zip per workspace holding
-- everything the purge will remove. A signed tenant job (`billing.retention_export`) builds it in phases with no transaction held across the object-store upload
-- (ADR-0003), and this row is its state and its record. No credit, wallet or report-artifact table is involved: it costs nothing and is not a report export.
--
--   status          requested | building | ready | failed. "Expired" is not stored: it is `expires_at` having passed, read at fetch time.
--   object_key      the FULL stored key (reports bucket) once `ready`; null before. Never returned to a client: a fetch mints a fresh 15-minute presign of it.
--   coverage        what the zip holds per project (date ranges and counts), validated against retentionExportCoverageSchema on write; null until built.
--   requested_by    the owner or admin who asked: the delivery email goes to them. SET NULL if that user is erased (the export itself ends with the deferral).
--   expires_at      LEAST(the deferral's end, request + 14 days). The link is valid until then.
--   emailed_at      when the delivery email was handed to the provider; null = not yet (the job retries the send, the provider de-duplicates on the row id).
--
-- At most ONE export is in flight per workspace (the partial unique index): a second request while one is requested or building is answered with that row.
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0134/0197/0202 precedent).
CREATE TABLE retention_exports (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'building', 'ready', 'failed')),
  object_key    text        CHECK (object_key IS NULL OR object_key <> ''),
  coverage      jsonb,
  error_code    text,
  expires_at    timestamptz NOT NULL,
  ready_at      timestamptz,
  emailed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_retention_exports_ready CHECK ((status = 'ready') = (object_key IS NOT NULL AND coverage IS NOT NULL AND ready_at IS NOT NULL))
);

CREATE UNIQUE INDEX ux_retention_exports_in_flight ON retention_exports (workspace_id) WHERE status IN ('requested', 'building');
CREATE INDEX ix_retention_exports_workspace ON retention_exports (workspace_id, created_at DESC);

COMMENT ON TABLE retention_exports IS
  'STORY-185 / decision 100 - the full-data export offered while a retention-shortening purge is pending: state, stored key and coverage. Tenant-scoped; not portal-readable; 0 credits.';

ALTER TABLE retention_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_exports FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'retention_exports' AND policyname = 'ws_isolation_retention_exports'
  ) THEN
    CREATE POLICY ws_isolation_retention_exports ON retention_exports
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
