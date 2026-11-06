-- 0167_prompt_research_keep_cap_and_free_price: STORY-080, OWNER DECISION 67 (f) and (a). Expand-only.
--
-- (f) ck_tr_shape - the prompt_research branch allowed 1..10 prompts. A Keep saves up to the 15 that Discover generates, and a kept set is stored in
--     tool_runs.prompt_texts, so the upper bound is now 15 (the lower bound and every other branch are unchanged). The per-RUN cap of 10 is held by the
--     request contract and the service, not by this constraint. Loosening a bound cannot fail on existing rows.
-- (a) Free publishes prompts.credits_per_generated = 1 (was null), so a Free workspace can Keep prompts at 1 credit each from its included credits. Only a
--     still-null value is rewritten, so re-running changes nothing; the free workspaces' entitlement_version is bumped so a cached resolution is not served stale.
ALTER TABLE tool_runs DROP CONSTRAINT ck_tr_shape;
ALTER TABLE tool_runs ADD CONSTRAINT ck_tr_shape CHECK (
  CASE tool_key
    WHEN 'visibility_scan'   THEN brand_name IS NOT NULL AND query_text IS NOT NULL
                                  AND COALESCE(array_length(engine_keys, 1), 0) BETWEEN 1 AND 4
    WHEN 'prompt_research'   THEN COALESCE(array_length(prompt_texts, 1), 0) BETWEEN 1 AND 15
    WHEN 'competitor_finder' THEN brand_url IS NOT NULL
    WHEN 'aux_audit'         THEN target_url IS NOT NULL
    WHEN 'schema_builder'    THEN status = 'expired' OR result_json IS NOT NULL
    WHEN 'compare_runs'      THEN diff_base_run_id IS NOT NULL AND diff_compare_run_id IS NOT NULL
  END);

UPDATE plans
   SET entitlements = jsonb_set(entitlements, ARRAY['prompts.credits_per_generated', 'value'], '1'::jsonb)
 WHERE key = 'free' AND entitlements -> 'prompts.credits_per_generated' -> 'value' = 'null'::jsonb;

UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE plan_key = 'free';
