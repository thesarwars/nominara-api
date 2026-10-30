-- Rollback of 0153_tool_runs_core_guards. Restores the 0004 constraints verbatim. Fails (loudly, by design) if a run naming gemini or an
-- empty engine/prompt array exists: rolling back must not silently delete a customer's stored run.
DROP TRIGGER tr_tool_runs_status_write_once ON tool_runs;
DROP FUNCTION app.tool_run_status_write_once();

ALTER TABLE tool_runs DROP CONSTRAINT ck_tr_shape;
ALTER TABLE tool_runs ADD CONSTRAINT ck_tr_shape CHECK (
  CASE tool_key
    WHEN 'visibility_scan'   THEN brand_name IS NOT NULL AND query_text IS NOT NULL
                                  AND array_length(engine_keys, 1) BETWEEN 1 AND 4
    WHEN 'prompt_research'   THEN array_length(prompt_texts, 1) BETWEEN 1 AND 10
    WHEN 'competitor_finder' THEN brand_url IS NOT NULL
    WHEN 'aux_audit'         THEN target_url IS NOT NULL
    WHEN 'schema_builder'    THEN result_json IS NOT NULL
    WHEN 'compare_runs'      THEN diff_base_run_id IS NOT NULL AND diff_compare_run_id IS NOT NULL
  END);

ALTER TABLE tool_runs DROP CONSTRAINT ck_tr_engine_set;
ALTER TABLE tool_runs ADD CONSTRAINT ck_tr_engine_set CHECK (NOT (engine_keys && ARRAY['gemini', 'claude']));
