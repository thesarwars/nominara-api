-- STORY-045 / owner decision 95(a) (2026-11-10) - prompt generation is a background job. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- `POST /v1/projects/{id}/prompts/generate` used to run the whole pass in the request's transaction, which made the naturaliser (a model call)
-- and vector dedupe (an embedding call) impossible to bind (NFR-ARCH-01, NFR-ARCH-04 / ADR-0003). It now records ONE row here, answers 202,
-- and a signed `prompt.generate` job runs the pass outside any transaction. This row is the pointer the caller polls.
--
--   id            the `generation_batch_id` - the same value every prompt the pass writes carries in tracked_prompts.generation_batch_id.
--                 Application-generated (UUIDv7), so the job's payload can name it before the row is visible to anything else.
--   status        pending (requested, not yet picked up) | running | succeeded | failed. Settled exactly once: the commit and the final-attempt
--                 recovery both write `WHERE status IN ('pending','running')`, so a redelivered job cannot rewrite an outcome.
--   request       the validated request body (contracts/prompts/generate-prompts-request.schema.ts), so a redelivery re-runs the SAME pass.
--   result        the old synchronous response, verbatim (contracts/prompts/generate-prompts-response.schema.ts): variants, rejected[],
--                 coverage[], summary. NULL unless status = 'succeeded' - a pass that did not finish is never stored as a short one.
--   failure_code  dispatch_failed | project_not_found | generation_failed; NULL unless status = 'failed'.
--
-- Charges nothing, ever (FR-FAN-01g): no wallet or ledger column is here and none is reachable from the job.
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0134/0163/0169 precedent).
CREATE TABLE prompt_generations (
  id            uuid        PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id    uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  request       jsonb       NOT NULL,
  result        jsonb,
  failure_code  text        CHECK (failure_code IN ('dispatch_failed', 'project_not_found', 'generation_failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT ck_prompt_generations_result  CHECK ((status = 'succeeded') = (result IS NOT NULL)),
  CONSTRAINT ck_prompt_generations_failure CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT ck_prompt_generations_settled CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);

-- A project's generations, newest first (the read route and any "is one already running" check).
CREATE INDEX ix_prompt_generations_project ON prompt_generations (project_id, created_at DESC);

COMMENT ON TABLE prompt_generations IS
  'STORY-045 / decision 95(a) - one background prompt-generation pass: the pointer POST /prompts/generate returns and GET /prompts/generations/{id} reads. Tenant-scoped; not portal-readable.';

ALTER TABLE prompt_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_generations FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prompt_generations' AND policyname = 'ws_isolation_prompt_generations'
  ) THEN
    CREATE POLICY ws_isolation_prompt_generations ON prompt_generations
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
