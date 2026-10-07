-- CP1 re-audit (e-reports MAJOR) — make scheduled_report_deliveries' foreign keys
-- tenant-consistent. Postgres evaluates FK checks without RLS, so the single-column
-- FKs from 0051 accepted another tenant's scheduled_report_id / report_artifact_id
-- (an existence oracle) and let that tenant's delete cascade into this one's history.
-- Composite (workspace_id, id) FKs bind every reference to the row's own tenant;
-- usage_reservations (0019) is the precedent. The table has no writer yet, so no
-- row can violate the new constraints.

ALTER TABLE scheduled_reports ADD CONSTRAINT scheduled_reports_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE report_artifacts  ADD CONSTRAINT report_artifacts_workspace_id_id_key  UNIQUE (workspace_id, id);

ALTER TABLE scheduled_report_deliveries
  DROP CONSTRAINT scheduled_report_deliveries_scheduled_report_id_fkey,
  DROP CONSTRAINT scheduled_report_deliveries_report_artifact_id_fkey;

ALTER TABLE scheduled_report_deliveries
  ADD CONSTRAINT scheduled_report_deliveries_report_fkey
    FOREIGN KEY (workspace_id, scheduled_report_id)
    REFERENCES scheduled_reports (workspace_id, id) ON DELETE CASCADE,
  -- SET NULL on the artifact column only: workspace_id is NOT NULL and must survive.
  ADD CONSTRAINT scheduled_report_deliveries_artifact_fkey
    FOREIGN KEY (workspace_id, report_artifact_id)
    REFERENCES report_artifacts (workspace_id, id) ON DELETE SET NULL (report_artifact_id);
