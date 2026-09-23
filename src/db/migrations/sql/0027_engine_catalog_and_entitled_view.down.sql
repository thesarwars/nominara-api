-- STORY-152 — reverse of 0027.
--
-- The view goes. The catalog rows do NOT: `answer_captures` and
-- `mention_facts` carry `engine_key` and `adapter_version` as provenance on
-- rows that outlive any migration, and deleting the catalog would orphan the
-- reference every captured result makes to it. A rollback that destroys the
-- meaning of already-captured data is not a rollback.
DROP VIEW IF EXISTS project_entitled_engines;
COMMENT ON TABLE project_engines IS NULL;
