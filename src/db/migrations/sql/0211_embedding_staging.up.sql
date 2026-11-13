-- STORY-186 (owner decision 104(c)) - stage a re-embed beside the live vector, so a project switches embedding models in ONE step.
--
-- embed.batch used to replace a stale vector in place, a batch at a time: mid re-embed a project's prompts sat under two models, the
-- L2 probe, generation dedupe and clustering each lost the rows that were switched, and a gradual release cost a user their cluster
-- rename (STORY-047). The re-embed now writes the NEW vector to `embedding_next` / `embedding_next_model` and leaves `embedding` /
-- `embedding_model` (the vector every similarity query reads) untouched. A project is promoted when its whole set is staged, by one
-- UPDATE (src/lib/embedding/reembed-promote.ts): `embedding := embedding_next`, `embedding_model := embedding_next_model`, staging cleared.
--
-- Only the two tables whose vector is replaced in place. content_chunks and corpus_passages carry the model in their unique key, so an
-- old-model row and a new-model row already coexist; they need no staging.
--
-- Expand only: four nullable columns, nothing rewritten, no index (nothing similarity-searches the staged vector). The check keeps the
-- pair honest: a staged vector always names its model and a model never stands alone. The columns sit on tables that already carry
-- workspace_id and FORCE ROW LEVEL SECURITY, so no policy changes.
ALTER TABLE tracked_prompts
  ADD COLUMN embedding_next       halfvec(1536),
  ADD COLUMN embedding_next_model text,
  ADD CONSTRAINT ck_tracked_prompts_embedding_next_pair CHECK ((embedding_next IS NULL) = (embedding_next_model IS NULL));

ALTER TABLE semantic_nodes
  ADD COLUMN embedding_next       halfvec(1536),
  ADD COLUMN embedding_next_model text,
  ADD CONSTRAINT ck_semantic_nodes_embedding_next_pair CHECK ((embedding_next IS NULL) = (embedding_next_model IS NULL));

COMMENT ON COLUMN tracked_prompts.embedding_next IS
  'STORY-186 - the vector under embedding_next_model, staged by a re-embed; promoted to embedding per project in one statement. Never read by a similarity query.';
COMMENT ON COLUMN semantic_nodes.embedding_next IS
  'STORY-186 - the vector under embedding_next_model, staged by a re-embed; promoted to embedding per project in one statement. Never read by a similarity query.';
