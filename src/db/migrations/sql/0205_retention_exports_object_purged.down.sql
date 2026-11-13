-- STORY-185 / decision 100(j) - rollback of 0205. LOSSY: the purge stamp is forgotten, so the cleanup would delete (already deleted) objects again, harmlessly.
DROP INDEX IF EXISTS ix_retention_exports_cleanup;
ALTER TABLE retention_exports DROP COLUMN IF EXISTS object_purged_at;
