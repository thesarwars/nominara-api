-- Rollback of 0146_topic_clusters_embedding_model. Loses only the record of which model produced each stored cluster centroid.
ALTER TABLE topic_clusters DROP COLUMN embedding_model;
