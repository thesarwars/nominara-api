-- Rollback of 0160. Drops the three functions and the seven policies and strips every right the dedicated role held. The ROLE itself is
-- left in place, as 0005's and 0112's downs do for cluster-scoped roles: CREATE ROLE is shared across databases, and an unprivileged
-- NOLOGIN role with no grants and no objects is inert.
-- @contract-phase
DROP FUNCTION IF EXISTS app.maintenance_recall_overlap(text, halfvec, integer);
DROP FUNCTION IF EXISTS app.maintenance_orphan_counts();
DROP FUNCTION IF EXISTS app.maintenance_default_partition_rows();
DROP POLICY IF EXISTS maintenance_count_answer_captures ON public.answer_captures;
DROP POLICY IF EXISTS maintenance_count_mention_facts ON public.mention_facts;
DROP POLICY IF EXISTS maintenance_count_citation_facts ON public.citation_facts;
DROP POLICY IF EXISTS maintenance_count_tracked_prompts ON public.tracked_prompts;
DROP POLICY IF EXISTS maintenance_count_topic_clusters ON public.topic_clusters;
DROP POLICY IF EXISTS maintenance_count_content_chunks ON public.content_chunks;
DROP POLICY IF EXISTS maintenance_count_corpus_passages ON public.corpus_passages;
REVOKE SELECT (id, workspace_id, captured_at)        ON answer_captures FROM nominara_maintenance;
REVOKE SELECT (workspace_id, result_id, captured_at) ON mention_facts   FROM nominara_maintenance;
REVOKE SELECT (workspace_id, result_id, captured_at) ON citation_facts  FROM nominara_maintenance;
REVOKE SELECT (id, embedding)                        ON tracked_prompts FROM nominara_maintenance;
REVOKE SELECT (id, centroid)                         ON topic_clusters  FROM nominara_maintenance;
REVOKE SELECT (id, embedding)                        ON content_chunks  FROM nominara_maintenance;
REVOKE SELECT (id, embedding)                        ON corpus_passages FROM nominara_maintenance;
REVOKE USAGE ON SCHEMA public FROM nominara_maintenance;
REVOKE USAGE ON SCHEMA app FROM nominara_owner;
