-- NEW-E-1 (Track E) — EXPAND phase. Lane range 0051-0053; renumbered at merge.
--
-- 1. D6: brand_themes.color_* become nullable with no default. NULL means
--    "use the platform default (Aurora Signal)". The old default #0ea5e9
--    failed AA contrast under white text, so it must not be silently stored.
--    Existing rows keep their stored colours; only new rows can be NULL.
-- 2. share_tokens.scope_tabs vocabulary becomes the portal's tab set
--    {overview, growth_map, matrix, sources, tasks}. Existing 'tracking'
--    rows map to {growth_map, matrix}; 'aux' has no portal tab and is dropped;
--    a row left empty falls back to {overview}. The new CHECK is added NOT
--    VALID here and validated in 0052 (its own transaction, per the 0030/0031
--    precedent), so the ACCESS EXCLUSIVE window stays short.
-- 3. scheduled_report_deliveries — per-attempt delivery history for scheduled
--    reports (status + failure reason). Tenant-scoped, NOT portal-readable.

ALTER TABLE brand_themes ALTER COLUMN color_primary DROP NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_primary DROP DEFAULT;
ALTER TABLE brand_themes ALTER COLUMN color_accent  DROP NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_accent  DROP DEFAULT;
ALTER TABLE brand_themes ALTER COLUMN color_bg      DROP NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_bg      DROP DEFAULT;
ALTER TABLE brand_themes ALTER COLUMN color_fg      DROP NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_fg      DROP DEFAULT;

ALTER TABLE share_tokens DROP CONSTRAINT share_tokens_scope_tabs_check;

UPDATE share_tokens
   SET scope_tabs = COALESCE(
         NULLIF(
           ARRAY(
             SELECT DISTINCT t
               FROM unnest(
                 ARRAY(SELECT x FROM unnest(scope_tabs) AS x WHERE x NOT IN ('tracking', 'aux'))
                 || CASE WHEN 'tracking' = ANY (scope_tabs) THEN ARRAY['growth_map', 'matrix'] ELSE ARRAY[]::text[] END
               ) AS t
              ORDER BY t
           ),
           ARRAY[]::text[]
         ),
         ARRAY['overview']
       )
 WHERE scope_tabs && ARRAY['tracking', 'aux'];

ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_scope_tabs_check
  CHECK (scope_tabs <@ ARRAY['overview','growth_map','matrix','sources','tasks']::text[]) NOT VALID;

CREATE TABLE scheduled_report_deliveries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scheduled_report_id uuid        NOT NULL REFERENCES scheduled_reports(id) ON DELETE CASCADE,
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  status              text        NOT NULL CHECK (status IN ('delivered','failed','skipped_cap','logged')),
  reason              text,
  recipient_count     integer     NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  report_artifact_id  uuid        REFERENCES report_artifacts(id) ON DELETE SET NULL
);
CREATE INDEX ix_scheduled_report_deliveries_report
  ON scheduled_report_deliveries (workspace_id, scheduled_report_id, attempted_at DESC);

COMMENT ON TABLE scheduled_report_deliveries IS
  'NEW-E-1 — one row per scheduled-report delivery attempt (history with failure reasons). Tenant-scoped; not portal-readable.';

ALTER TABLE scheduled_report_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_report_deliveries FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_report_deliveries' AND policyname = 'ws_isolation_scheduled_report_deliveries'
  ) THEN
    CREATE POLICY ws_isolation_scheduled_report_deliveries ON scheduled_report_deliveries
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
