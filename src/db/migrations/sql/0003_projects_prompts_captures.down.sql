-- Dropping a partitioned parent drops all its partitions (default and the
-- dynamically created monthly ones) automatically — no need to enumerate them.
DROP TABLE IF EXISTS displacement_events;
DROP TABLE IF EXISTS citation_facts;
DROP TABLE IF EXISTS mention_facts;
DROP TABLE IF EXISTS answer_captures;
DROP TABLE IF EXISTS capture_runs;
DROP TABLE IF EXISTS topic_clusters;
DROP TABLE IF EXISTS prompt_stability;
DROP TABLE IF EXISTS tracked_prompts;
DROP TABLE IF EXISTS domain_verifications;
DROP TABLE IF EXISTS competitors;
DROP TABLE IF EXISTS project_engines;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS engine_health;
DROP TABLE IF EXISTS engines;
