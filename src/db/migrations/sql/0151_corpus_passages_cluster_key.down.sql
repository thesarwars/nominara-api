-- Rollback of 0151_corpus_passages_cluster_key.
--
-- The narrower key can only be rebuilt if no text is held twice, and the widened key exists precisely so that it may be (once per
-- cluster). corpus_passages is a 30-day CACHE that a rebuild repopulates from citation_facts, so the rows that would violate the
-- old key are removed, keeping the earliest-created copy of each (workspace, content_hash, embedding_model). That is the one
-- destructive step of this rollback; it loses only cached passages (and their vectors), never a customer's own data.
DELETE FROM corpus_passages cp
 USING (
   SELECT id,
          row_number() OVER (PARTITION BY workspace_id, content_hash, embedding_model ORDER BY created_at, id) AS rn
     FROM corpus_passages
 ) ranked
 WHERE cp.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_passages ON corpus_passages (workspace_id, content_hash, embedding_model);
DROP INDEX IF EXISTS ux_corpus_passages_cluster;

ALTER TABLE semantic_nodes DROP COLUMN collapsed_into_id;
ALTER TABLE semantic_nodes DROP COLUMN embedding_model;
