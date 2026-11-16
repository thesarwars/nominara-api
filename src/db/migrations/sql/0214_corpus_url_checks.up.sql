-- STORY-058 AC4 / owner decision 108(g) - a per-URL record of a build's check, so a URL that yields no passage of its own is not re-fetched
-- on every build while the 30-day cache is live. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- corpus_passages is unique on (workspace, project, cluster, content_hash, model), so a URL whose every relevant passage is a copy of text
-- another URL of the same cluster already holds gets no row of its own, and neither does a URL with no chunk relevant to the cluster. The
-- "is it cached" test reads corpus_passages, so both were fetched again on every build. This table is that missing record.
--
--   outcome   duplicate_only      fetched; every kept passage was already held under another URL of this corpus
--             no_relevant_chunk   fetched; no chunk shared a term with the cluster's prompts
--   Only these two. A URL the guard refused or that failed is a transient condition, not a result, and is never recorded: it is tried again.
--
-- Keyed like the passages it stands in for: (workspace, project, cluster, url hash, model), NULLS NOT DISTINCT because the cluster is nullable.
-- expires_at is the same 30 days as a passage's, so a check never outlives the cache it belongs to. Holds a URL hash and an outcome: no text.
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0134/0163/0169/0193/0197 precedent).
CREATE TABLE corpus_url_checks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id         uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  prompt_cluster_id  uuid,
  citation_url_hash  bytea       NOT NULL,
  embedding_model    text        NOT NULL,
  outcome            text        NOT NULL CHECK (outcome IN ('duplicate_only', 'no_relevant_chunk')),
  checked_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);

-- One record per URL per corpus and model; the build's read, upsert and cleanup are all keyed on it.
CREATE UNIQUE INDEX ux_corpus_url_checks ON corpus_url_checks
  (workspace_id, project_id, prompt_cluster_id, citation_url_hash, embedding_model) NULLS NOT DISTINCT;

COMMENT ON TABLE corpus_url_checks IS
  'STORY-058 AC4 / decision 108(g) - a fetched URL that produced no passage of its own (duplicate_only, no_relevant_chunk), so it is not re-fetched until expires_at. Tenant-scoped; not portal-readable; holds no page text.';

ALTER TABLE corpus_url_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE corpus_url_checks FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'corpus_url_checks' AND policyname = 'ws_isolation_corpus_url_checks'
  ) THEN
    CREATE POLICY ws_isolation_corpus_url_checks ON corpus_url_checks
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
