-- Rollback of 0145_tracked_prompts_embedding_model. Loses only the record of which model produced each stored prompt vector.
ALTER TABLE tracked_prompts DROP COLUMN embedding_model;
