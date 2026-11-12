-- STORY-191 / owner decision 99(c) (2026-11-12) - model-judged brand-name matches. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- A2 disambiguation risk (scoring-models.md section 10) is the share of brand-name matches NOT about the brand. The v1 case heuristic cannot settle a
-- sentence-initial or markup-wrapped capitalised word, or a lowercase-only brand; a model judge decides those, OUTSIDE any transaction (ADR-0003),
-- and its verdicts live here. `mention_facts` is untouched.
--
--   mention_fact_id + captured_at  the match judged (mention_facts' key is (captured_at, id); there is no foreign key to a partitioned fact table,
--                                  the same as every other fact reference). A verdict outlives nothing it needs: it holds ids and a label, no text.
--   judge_version                  the judge's identity AND its prompt version, e.g. 'gemini-2.5-flash:name-match-v1'. A change of model or prompt is a
--                                  new version, so the matches are judged again and the old verdicts are simply no longer read.
--   judge_model                    the model id alone, for audit and the monthly cap's per-model view.
--   verdict                        about_brand | not_about_brand | unjudged (the model could not decide: stored so a re-run does not ask again, and
--                                  read as outside the risk denominator, never guessed to be about the brand).
--
-- Only MODEL verdicts are stored. The v1 heuristic is pure and recomputed on read, so it has no rows.
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0134/0163/0169/0193 precedent).
CREATE TABLE name_match_verdicts (
  id               uuid        PRIMARY KEY,
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id       uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  mention_fact_id  uuid        NOT NULL,
  captured_at      timestamptz NOT NULL,
  judge_version    text        NOT NULL CHECK (judge_version <> ''),
  judge_model      text        NOT NULL CHECK (judge_model <> ''),
  verdict          text        NOT NULL CHECK (verdict IN ('about_brand', 'not_about_brand', 'unjudged')),
  judged_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_name_match_verdicts_mention_judge UNIQUE (mention_fact_id, judge_version)
);

-- The monthly cap counts a workspace's model verdicts since the start of the month.
CREATE INDEX ix_name_match_verdicts_ws_time ON name_match_verdicts (workspace_id, judged_at);
-- The window read joins on the mention; the unique constraint above serves it. This one serves a project's retention and erasure sweeps.
CREATE INDEX ix_name_match_verdicts_project ON name_match_verdicts (project_id);

COMMENT ON TABLE name_match_verdicts IS
  'STORY-191 / decision 99(c) - one model verdict per (brand-name match, judge version). Feeds A2 disambiguation risk. Tenant-scoped; not portal-readable; holds no answer text.';

ALTER TABLE name_match_verdicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE name_match_verdicts FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'name_match_verdicts' AND policyname = 'ws_isolation_name_match_verdicts'
  ) THEN
    CREATE POLICY ws_isolation_name_match_verdicts ON name_match_verdicts
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
