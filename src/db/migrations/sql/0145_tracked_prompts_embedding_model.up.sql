-- STORY-133 DECISION 2 / EC-23 - the model that produced a stored vector, pinned on the row.
--
-- content_chunks, corpus_passages and geo_alignments carry embedding_model; tracked_prompts did not, and it is the column that all
-- three similarity thresholds (L2 0.94, generation dedupe 0.92, clustering 0.82) read. Mixing vector spaces gives silently wrong
-- cosine values, so embed.batch writes the model beside every vector it stores. Expand only: one nullable column, nothing
-- rewritten. NULL on every existing row, and every existing embedding is NULL, so there is nothing to backfill.
--
-- NOT DONE HERE (the story's DECISION 2 also names them, the owner has not signed them off): the same column on topic_clusters and
-- semantic_nodes, and a unique key including the model on tracked_prompts.
ALTER TABLE tracked_prompts ADD COLUMN embedding_model text;

COMMENT ON COLUMN tracked_prompts.embedding_model IS
  'STORY-133 - the model that produced tracked_prompts.embedding (EC-23). NULL while embedding is NULL.';
