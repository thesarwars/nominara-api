-- Rollback of 0211_embedding_staging. Loses only vectors staged and not yet promoted; the live vectors are untouched.
ALTER TABLE semantic_nodes DROP CONSTRAINT ck_semantic_nodes_embedding_next_pair, DROP COLUMN embedding_next_model, DROP COLUMN embedding_next;
ALTER TABLE tracked_prompts DROP CONSTRAINT ck_tracked_prompts_embedding_next_pair, DROP COLUMN embedding_next_model, DROP COLUMN embedding_next;
