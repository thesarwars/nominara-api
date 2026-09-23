-- STORY-152 — reverse of 0027.
--
-- The view goes. The catalog rows do NOT: `answer_captures` and
-- `mention_facts` carry `engine_key` and `adapter_version` as provenance on
-- rows that outlive any migration, and deleting the catalog would orphan the
-- reference every captured result makes to it. A rollback that destroys the
-- meaning of already-captured data is not a rollback.
DROP VIEW IF EXISTS project_entitled_engines;
COMMENT ON TABLE project_engines IS NULL;

-- The shape constraint and its helper go with the view, in dependency order:
-- the CHECK references the function, so the constraint must be dropped first.
--
-- These are safe to drop where the rows are not, because a constraint carries
-- no data -- nothing recorded elsewhere refers back to it, which is exactly
-- what is untrue of the catalog rows above.
ALTER TABLE engines DROP CONSTRAINT IF EXISTS engines_cadence_by_plan_castable;
DROP FUNCTION IF EXISTS app.cadence_by_plan_is_castable(jsonb);
