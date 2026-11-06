-- Rollback of 0167_prompt_research_keep_cap_and_free_price. Restores the 0..10 bound (fails loudly, by design, if a kept set of 11..15 prompts is stored: a
-- customer's stored run is never silently deleted) and Free's null price.
ALTER TABLE tool_runs DROP CONSTRAINT ck_tr_shape;
ALTER TABLE tool_runs ADD CONSTRAINT ck_tr_shape CHECK (
  CASE tool_key
    WHEN 'visibility_scan'   THEN brand_name IS NOT NULL AND query_text IS NOT NULL
                                  AND COALESCE(array_length(engine_keys, 1), 0) BETWEEN 1 AND 4
    WHEN 'prompt_research'   THEN COALESCE(array_length(prompt_texts, 1), 0) BETWEEN 1 AND 10
    WHEN 'competitor_finder' THEN brand_url IS NOT NULL
    WHEN 'aux_audit'         THEN target_url IS NOT NULL
    WHEN 'schema_builder'    THEN status = 'expired' OR result_json IS NOT NULL
    WHEN 'compare_runs'      THEN diff_base_run_id IS NOT NULL AND diff_compare_run_id IS NOT NULL
  END);

UPDATE plans
   SET entitlements = jsonb_set(entitlements, ARRAY['prompts.credits_per_generated', 'value'], 'null'::jsonb)
 WHERE key = 'free' AND entitlements -> 'prompts.credits_per_generated' -> 'value' = '1'::jsonb;
