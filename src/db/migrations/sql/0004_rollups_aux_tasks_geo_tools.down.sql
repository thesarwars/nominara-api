-- Drop the FK discharge onto displacement_events FIRST — that table belongs
-- to 0003 and isn't dropped here, so DROP TABLE tasks below would fail
-- without this. Then drop every table this migration created, in exact
-- reverse creation order. No CASCADE anywhere, matching 0002/0003 style.
ALTER TABLE displacement_events DROP CONSTRAINT IF EXISTS displacement_events_task_id_fkey;

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS report_artifacts;
DROP TABLE IF EXISTS scheduled_reports;
DROP TABLE IF EXISTS share_token_views;
DROP TABLE IF EXISTS share_tokens;
DROP TABLE IF EXISTS custom_domains;
DROP TABLE IF EXISTS brand_themes;
DROP TABLE IF EXISTS gsc_daily;
DROP TABLE IF EXISTS gsc_connections;
DROP TABLE IF EXISTS attribution_url_rollup;
DROP TABLE IF EXISTS attribution_daily;
DROP TABLE IF EXISTS attribution_configs;
DROP TABLE IF EXISTS tool_runs;

DROP TABLE IF EXISTS patches;
DROP TABLE IF EXISTS semantic_nodes;
DROP TABLE IF EXISTS corpus_passages;
DROP TABLE IF EXISTS content_chunks;
DROP TABLE IF EXISTS geo_alignments;
DROP TABLE IF EXISTS entity_nodes;
DROP TABLE IF EXISTS geo_analyses;

DROP TABLE IF EXISTS ref_counters;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS tasks;

DROP TABLE IF EXISTS aux_findings;
DROP TABLE IF EXISTS aux_audits;

DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS milestones;
DROP TABLE IF EXISTS metric_daily;
DROP TABLE IF EXISTS project_source_index;
DROP TABLE IF EXISTS source_domains;

DROP TABLE IF EXISTS platform_metrics;
DROP TABLE IF EXISTS niche_reports;
DROP TABLE IF EXISTS task_generation_rules;
DROP TABLE IF EXISTS aux_rule_catalog;
