-- STORY-047 / owner decision 2026-10-28 #4 (EC-23) - the model whose vector space a cluster's centroid lives in.
--
-- A centroid is the mean of member prompt embeddings, so it is only comparable with vectors from the SAME model. The clustering
-- job writes the model beside every centroid it stores, so a later model switch cannot be mistaken for a cosine that means
-- something. Expand only: one nullable column, nothing rewritten. NULL on every existing row (nothing has ever inserted a
-- cluster), so there is nothing to backfill.
ALTER TABLE topic_clusters ADD COLUMN embedding_model text;

COMMENT ON COLUMN topic_clusters.embedding_model IS
  'STORY-047 - the model that produced the member embeddings topic_clusters.centroid is the mean of (EC-23). NULL while centroid is NULL.';
