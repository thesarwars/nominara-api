-- STORY-185 fix round - rollback of 0206. LOSSY: existing exports lose the scope they were built for (none can then be matched or reused).
ALTER TABLE retention_exports DROP COLUMN IF EXISTS scope;
