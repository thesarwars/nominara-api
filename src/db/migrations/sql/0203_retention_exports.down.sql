-- STORY-185 / decision 100 - rollback of 0203_retention_exports. LOSSY: the export rows (state, coverage, the stored key) are forgotten; an object already in the bucket is orphaned inside the workspace's own prefix.
DROP TABLE IF EXISTS retention_exports;
