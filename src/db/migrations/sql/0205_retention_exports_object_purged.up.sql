-- STORY-185 / owner decision 100(j) - the stored zip is deleted when its link expires. EXPAND-ONLY: one nullable column, nothing existing is altered.
--
-- `object_purged_at` is stamped by the nightly cleanup (the `report.cleanup` queue) AFTER the object has been deleted from the reports bucket, outside any
-- transaction. Null on a `ready` row whose link has expired means "the object may still exist: delete it". `object_key` is KEPT (the CHECK ties `ready`
-- to a key, and the key is the record of what was stored); the download route answers 404 for an expired or purged export, and never presigns it.
ALTER TABLE retention_exports ADD COLUMN object_purged_at timestamptz;

-- What the cleanup scans: ready, expired, not yet purged.
CREATE INDEX ix_retention_exports_cleanup ON retention_exports (expires_at) WHERE status = 'ready' AND object_purged_at IS NULL;

COMMENT ON COLUMN retention_exports.object_purged_at IS
  'STORY-185 / decision 100(j) - when the stored zip was deleted after its link expired; null = not yet (or never stored). Never read to serve a download.';
