-- STORY-078 - the shared tool core's database guarantees. No new column or table; three constraint-level changes on tool_runs.
--
-- 1. ck_tr_engine_set - OWNER DECISION 26 (2026-10-30): Gemini is allowed in the Tools engine set. The constraint existed to keep the two
--    most expensive engines out of Tools (gemini and claude); Gemini is now the one real engine and Tools use of it stays under its
--    engine spend ceiling. Claude stays barred: a constraint, not a code path, so a new call site cannot bypass it.
-- 2. ck_tr_shape - KNOWN GAP E-1 closed. array_length('{}', 1) and array_length(NULL, 1) are NULL, and a CHECK that evaluates to NULL
--    PASSES, so a visibility scan with an empty engine set and a prompt-research run with no prompts were accepted. The bounds are now
--    taken over COALESCE(array_length(...), 0), so NULL and empty fail like zero. Every other branch is unchanged.
--    The schema_builder branch is relaxed for an EXPIRED run only: Schema Builder stores its result at the start (it captures nothing),
--    and the retention sweep nulls result_json when the window ends, which `result_json IS NOT NULL` alone would refuse (23514) and
--    abort the nightly pass for every tenant. A live schema_builder run still must carry its result.
-- 3. app.tool_run_status_write_once - AC5 "the transition is written once". A run leaves 'running' to exactly one of completed /
--    partial / failed, and a terminal run never changes its status again. The one other move is the retention sweep's: a FINISHED run
--    may become 'expired', and an expired run stays expired. A run still 'running' can NOT expire: its charge has not been settled, and
--    expiring it would strand the debit forever (KAD-12: every reserve ends in a commit or a release). A run whose worker died is
--    settled as failed-and-refunded by the stale-run reaper (retention.ts) and only then expires. An UPDATE that leaves status
--    unchanged (a pin, a conversion stamp) is not a transition and is not touched.
--
-- Contract (tightening) steps on a table nothing has ever written: no data to repair, and a populated table would fail the ADD CONSTRAINT
-- loudly rather than weaken the guarantee.
ALTER TABLE tool_runs DROP CONSTRAINT ck_tr_engine_set;
ALTER TABLE tool_runs ADD CONSTRAINT ck_tr_engine_set CHECK (NOT (engine_keys && ARRAY['claude']));

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

CREATE FUNCTION app.tool_run_status_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'running' AND NEW.status IN ('completed', 'partial', 'failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'partial', 'failed') AND NEW.status = 'expired' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tool_runs status cannot move from % to % (a run leaves running once; only expiry follows a finished run)', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER tr_tool_runs_status_write_once BEFORE UPDATE OF status ON tool_runs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.tool_run_status_write_once();
