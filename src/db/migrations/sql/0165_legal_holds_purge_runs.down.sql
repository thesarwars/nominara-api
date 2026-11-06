-- Rollback of 0165_legal_holds_purge_runs (STORY-111). Drops the two tables it created.
DROP TABLE IF EXISTS subject_erasure_queue;
DROP TABLE IF EXISTS purge_runs;
DROP TABLE IF EXISTS legal_holds;
