-- Rollback of 0161_report_artifact_link_token. Drops the link token columns: an emailed link stops working (the route answers 404),
-- the artifacts and their files are untouched.
DROP INDEX ux_report_artifacts_link_token;
ALTER TABLE report_artifacts
  DROP COLUMN link_revoked_at,
  DROP COLUMN link_token_hash;
