-- STORY-059 AC1 / owner decision 11 (2026-10-29) - the corpus_passages key carries the project and the prompt cluster.
--
-- ux_corpus_passages was (workspace_id, content_hash, embedding_model): identical passage text cited by two clusters or
-- projects of one workspace was stored by ONE of them, while the centroid reads per (project_id, prompt_cluster_id). The key
-- becomes (workspace_id, project_id, prompt_cluster_id, content_hash, embedding_model): one embedding per (cluster, text).
--
-- EXPAND, THEN CONTRACT, in this order inside one transaction. The new, WIDER index is built first, so at every instant a
-- unique constraint covers every row and no write is ever unprotected; only then is the old, narrower one dropped. Every row
-- that satisfied the old key satisfies the new one (a superset of its columns), so the build cannot fail on existing data.
--
-- NULLS NOT DISTINCT: prompt_cluster_id is nullable. Without it a NULL cluster would be unique-by-default (NULL <> NULL) and the
-- same text could be stored for the same project any number of times. Postgres 18, which this repository targets, has it.
--
-- NOT `CONCURRENTLY`: the migration runner wraps each file in a transaction and CREATE INDEX CONCURRENTLY cannot run in one (see
-- 0025). corpus_passages is a 30-day cache of at most ~75 rows per cluster and nothing writes it in production yet; if that stops
-- being true, build the index out of band first - IF NOT EXISTS makes the statement below a no-op then.
CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_passages_cluster ON corpus_passages
  (workspace_id, project_id, prompt_cluster_id, content_hash, embedding_model) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS ux_corpus_passages;

-- STORY-059 / owner decision 2026-10-28 #4 (EC-23) - the model whose vector space a semantic node's embedding lives in.
--
-- A node embedding is only comparable with vectors from the SAME model (presence at cosine 0.90, dedupe at 0.93, projected gain
-- against the centroid), so the story that writes semantic_nodes writes the model beside every vector. Expand only: one nullable
-- column, nothing rewritten. NULL on every existing row (nothing has ever inserted a node), so there is nothing to backfill.
ALTER TABLE semantic_nodes ADD COLUMN embedding_model text;

COMMENT ON COLUMN semantic_nodes.embedding_model IS
  'STORY-059 - the model that produced semantic_nodes.embedding (EC-23). NULL while embedding is NULL.';

-- STORY-059 AC6 (review round 3) - a near-duplicate semantic node is COLLAPSED, not deleted.
--
-- The analysis used to DELETE the lower-prevalence node of a near-duplicate pair, but the next extraction still yields that phrase, so it
-- was inserted again with no vector and embedded again on every cycle. The collapse is now a fact stored on the row: `collapsed_into_id`
-- names the keeper. Extraction keeps the row (and its vector) and never re-inserts or re-embeds the phrase; every reader excludes rows
-- where it is set. ON DELETE SET NULL: a keeper that later goes away (its concept fell below the prevalence threshold) does not orphan or
-- hide its collapsed rows - they become live again, vector intact, and the next analysis judges them afresh. Expand only: one nullable
-- column, NULL on every existing row (nothing has ever inserted a node), so there is nothing to backfill.
ALTER TABLE semantic_nodes ADD COLUMN collapsed_into_id uuid REFERENCES semantic_nodes (id) ON DELETE SET NULL;

COMMENT ON COLUMN semantic_nodes.collapsed_into_id IS
  'STORY-059 AC6 - the surviving node this near-duplicate (cosine >= 0.93) was collapsed into; NULL for a live node. Readers exclude non-NULL.';
