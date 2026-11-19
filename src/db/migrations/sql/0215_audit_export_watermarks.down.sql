-- Rollback of 0215_audit_export_watermarks. Loses only the export's memory: the next nightly export has no watermark and exports every chain in
-- full once (a duplicate of what is already in storage, never a gap), then resumes incrementally.
DROP TABLE audit_export_watermarks;
