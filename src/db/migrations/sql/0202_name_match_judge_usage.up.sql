-- STORY-191 fix round / owner decision 99(l) (2026-11-12) - the monthly model-judging meter. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- The cap on model-judged matches per workspace per month used to be read from stored verdicts in `prepare` and never reserved, so concurrent jobs across a
-- workspace's projects each saw the same remaining budget and overshot it, and a billed batch that failed stored nothing and so was never counted. This row is the
-- meter instead: `prepare` RESERVES its matches here atomically (a row lock, in a short tenant transaction) BEFORE any model call, and `commit` gives back
-- only the reservation that was never sent. It counts matches ATTEMPTED (sent to the model), not verdicts stored.
--
--   workspace_id + month   one row per workspace per UTC calendar month (month is the first day).
--   matches_sent           matches reserved and not given back: sent to the model, or reserved by a job that died before it could release (conservative).
--
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0193/0197 precedent).
CREATE TABLE name_match_judge_usage (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month         date        NOT NULL,
  matches_sent  integer     NOT NULL DEFAULT 0 CHECK (matches_sent >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month)
);

COMMENT ON TABLE name_match_judge_usage IS
  'STORY-191 fix round / decision 99(l) - matches reserved for model name-match judging per workspace per UTC month; the monthly cap is enforced against it. Tenant-scoped; not portal-readable.';

ALTER TABLE name_match_judge_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE name_match_judge_usage FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'name_match_judge_usage' AND policyname = 'ws_isolation_name_match_judge_usage'
  ) THEN
    CREATE POLICY ws_isolation_name_match_judge_usage ON name_match_judge_usage
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
