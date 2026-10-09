ALTER TABLE scheduled_report_deliveries
  DROP CONSTRAINT scheduled_report_deliveries_report_fkey,
  DROP CONSTRAINT scheduled_report_deliveries_artifact_fkey;

ALTER TABLE scheduled_report_deliveries
  ADD CONSTRAINT scheduled_report_deliveries_scheduled_report_id_fkey
    FOREIGN KEY (scheduled_report_id) REFERENCES scheduled_reports (id) ON DELETE CASCADE,
  ADD CONSTRAINT scheduled_report_deliveries_report_artifact_id_fkey
    FOREIGN KEY (report_artifact_id) REFERENCES report_artifacts (id) ON DELETE SET NULL;

ALTER TABLE report_artifacts  DROP CONSTRAINT report_artifacts_workspace_id_id_key;
ALTER TABLE scheduled_reports DROP CONSTRAINT scheduled_reports_workspace_id_id_key;
