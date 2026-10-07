-- Reverse of 0045. Drops the per-project competitor override: after rollback a
-- competitor domain's seedability is again read from the shared source_domains row.
ALTER TABLE project_source_index DROP COLUMN scoring_version;
ALTER TABLE project_source_index DROP COLUMN is_competitor_owned;
