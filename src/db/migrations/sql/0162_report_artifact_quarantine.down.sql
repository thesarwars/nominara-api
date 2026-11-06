-- Rollback of 0162_report_artifact_quarantine. Drops the quarantine flag: a quarantined row becomes due again on the next cleanup, which
-- refuses it again (its key is unchanged) and, with the column gone, would fail the run until the row is repaired or removed.
ALTER TABLE report_artifacts DROP COLUMN quarantined_at;
