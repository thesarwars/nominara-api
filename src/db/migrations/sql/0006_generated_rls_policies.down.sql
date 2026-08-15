-- Reverse of 0006.up.sql.
--
-- ROLLING THIS BACK RE-OPENS EVERY TENANT BOUNDARY IN THE DATABASE. This is
-- the "single most load-bearing story in the repository" (STORY-011's own
-- description) — matching 0005.down.sql's tone for its own significant
-- down-migration caveat, but more severe: 0005's rollback removed grants;
-- this rollback removes the row-level isolation that keeps one tenant from
-- reading or writing another's data. Do not apply this against anything
-- that has ever held real tenant data.
--
-- Hand-authored, NOT generated (per this story's Technical Notes: the up
-- migration is committed generator output; the down migration is the one
-- hand-written exception, since "reverse everything the generator did" has
-- no meaningful pure-function form of its own — see src/db/rls/generate.ts's
-- module header). The per-table list below was produced by inspecting the
-- exact same 59-tenant/18-portal-readable sets the generator itself
-- consults (conventions.ts's GLOBAL_TABLES / PORTAL_READABLE_TABLES — fix
-- pass STORY-011-E-2 removed source_domains/brand_themes, dropping this
-- count from 20 to 18; their two DROP POLICY IF EXISTS lines below are
-- harmless no-ops against a freshly-applied 0006.up.sql but are left in
-- place so this file still rolls back a database that had them from before
-- this fix pass), so it cannot silently drift from what 0006.up.sql
-- actually created.
--
-- Idempotency: DROP POLICY IF EXISTS / ALTER TABLE ... NO FORCE / DISABLE
-- ROW LEVEL SECURITY are all naturally idempotent — no DO-block guard is
-- needed here the way 0006.up.sql needs one for CREATE POLICY.

-- ============================================================================
-- Partition children first — mirrors app.apply_tenant_rls's own discovery
-- query (pg_inherits, relkind = 'r' under a relkind = 'p' parent) rather
-- than naming them, since partition names are computed dynamically at
-- migration-apply time and this migration cannot hardcode them either.
-- ============================================================================
DO $$
DECLARE
  child        regclass;
  child_name   text;
BEGIN
  FOR child IN
    SELECT c.oid::regclass
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND p.relkind = 'p'
  LOOP
    SELECT relname INTO child_name FROM pg_class WHERE oid = child;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', 'ws_isolation_' || child_name, child);
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', child);
    EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', child);
  END LOOP;
END $$;

-- ============================================================================
-- The 59 tenant tables (alphabetical, matching 0006.up.sql's own ordering).
-- portal_scope_* is dropped before ws_isolation_* wherever both exist, on
-- the 18 portal-readable tables.
-- ============================================================================

DROP POLICY IF EXISTS portal_scope_answer_captures ON answer_captures;
DROP POLICY IF EXISTS ws_isolation_answer_captures ON answer_captures;
ALTER TABLE answer_captures NO FORCE ROW LEVEL SECURITY;
ALTER TABLE answer_captures DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_api_keys ON api_keys;
ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_attribution_configs ON attribution_configs;
ALTER TABLE attribution_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attribution_configs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_attribution_daily ON attribution_daily;
ALTER TABLE attribution_daily NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attribution_daily DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_attribution_url_rollup ON attribution_url_rollup;
DROP POLICY IF EXISTS ws_isolation_attribution_url_rollup ON attribution_url_rollup;
ALTER TABLE attribution_url_rollup NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attribution_url_rollup DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_audit_log ON audit_log;
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_aux_audits ON aux_audits;
DROP POLICY IF EXISTS ws_isolation_aux_audits ON aux_audits;
ALTER TABLE aux_audits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE aux_audits DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_aux_findings ON aux_findings;
DROP POLICY IF EXISTS ws_isolation_aux_findings ON aux_findings;
ALTER TABLE aux_findings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE aux_findings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_brand_themes ON brand_themes;
DROP POLICY IF EXISTS ws_isolation_brand_themes ON brand_themes;
ALTER TABLE brand_themes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE brand_themes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_capture_runs ON capture_runs;
ALTER TABLE capture_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_citation_facts ON citation_facts;
DROP POLICY IF EXISTS ws_isolation_citation_facts ON citation_facts;
ALTER TABLE citation_facts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE citation_facts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_competitors ON competitors;
DROP POLICY IF EXISTS ws_isolation_competitors ON competitors;
ALTER TABLE competitors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE competitors DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_content_chunks ON content_chunks;
ALTER TABLE content_chunks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_chunks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_corpus_passages ON corpus_passages;
ALTER TABLE corpus_passages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE corpus_passages DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_credit_daily_counters ON credit_daily_counters;
ALTER TABLE credit_daily_counters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_daily_counters DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_credit_ledger ON credit_ledger;
ALTER TABLE credit_ledger NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_credit_purchases ON credit_purchases;
ALTER TABLE credit_purchases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_purchases DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_credit_wallets ON credit_wallets;
ALTER TABLE credit_wallets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_wallets DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_custom_domains ON custom_domains;
ALTER TABLE custom_domains NO FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_domains DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_displacement_events ON displacement_events;
DROP POLICY IF EXISTS ws_isolation_displacement_events ON displacement_events;
ALTER TABLE displacement_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE displacement_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_domain_verifications ON domain_verifications;
ALTER TABLE domain_verifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_verifications DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_entity_nodes ON entity_nodes;
DROP POLICY IF EXISTS ws_isolation_entity_nodes ON entity_nodes;
ALTER TABLE entity_nodes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE entity_nodes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_geo_alignments ON geo_alignments;
ALTER TABLE geo_alignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE geo_alignments DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_geo_analyses ON geo_analyses;
DROP POLICY IF EXISTS ws_isolation_geo_analyses ON geo_analyses;
ALTER TABLE geo_analyses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE geo_analyses DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_goals ON goals;
DROP POLICY IF EXISTS ws_isolation_goals ON goals;
ALTER TABLE goals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE goals DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_gsc_connections ON gsc_connections;
ALTER TABLE gsc_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gsc_connections DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_gsc_daily ON gsc_daily;
ALTER TABLE gsc_daily NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gsc_daily DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_invoices ON invoices;
ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_mention_facts ON mention_facts;
DROP POLICY IF EXISTS ws_isolation_mention_facts ON mention_facts;
ALTER TABLE mention_facts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mention_facts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_metric_daily ON metric_daily;
DROP POLICY IF EXISTS ws_isolation_metric_daily ON metric_daily;
ALTER TABLE metric_daily NO FORCE ROW LEVEL SECURITY;
ALTER TABLE metric_daily DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_milestones ON milestones;
DROP POLICY IF EXISTS ws_isolation_milestones ON milestones;
ALTER TABLE milestones NO FORCE ROW LEVEL SECURITY;
ALTER TABLE milestones DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_notifications ON notifications;
ALTER TABLE notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_patches ON patches;
ALTER TABLE patches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE patches DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_project_engines ON project_engines;
ALTER TABLE project_engines NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_engines DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_project_source_index ON project_source_index;
DROP POLICY IF EXISTS ws_isolation_project_source_index ON project_source_index;
ALTER TABLE project_source_index NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_source_index DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_projects ON projects;
DROP POLICY IF EXISTS ws_isolation_projects ON projects;
ALTER TABLE projects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_prompt_stability ON prompt_stability;
ALTER TABLE prompt_stability NO FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_stability DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_ref_counters ON ref_counters;
ALTER TABLE ref_counters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ref_counters DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_report_artifacts ON report_artifacts;
ALTER TABLE report_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE report_artifacts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_scheduled_reports ON scheduled_reports;
ALTER TABLE scheduled_reports NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reports DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_semantic_nodes ON semantic_nodes;
ALTER TABLE semantic_nodes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_nodes DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_share_token_views ON share_token_views;
ALTER TABLE share_token_views NO FORCE ROW LEVEL SECURITY;
ALTER TABLE share_token_views DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_share_tokens ON share_tokens;
ALTER TABLE share_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE share_tokens DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_source_domains ON source_domains;
DROP POLICY IF EXISTS ws_isolation_source_domains ON source_domains;
ALTER TABLE source_domains NO FORCE ROW LEVEL SECURITY;
ALTER TABLE source_domains DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_sso_configurations ON sso_configurations;
ALTER TABLE sso_configurations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sso_configurations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_subscription_addons ON subscription_addons;
ALTER TABLE subscription_addons NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_addons DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_subscriptions ON subscriptions;
ALTER TABLE subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_support_grants ON support_grants;
ALTER TABLE support_grants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE support_grants DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_task_events ON task_events;
ALTER TABLE task_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE task_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_tasks ON tasks;
DROP POLICY IF EXISTS ws_isolation_tasks ON tasks;
ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_tool_runs ON tool_runs;
ALTER TABLE tool_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tool_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_topic_clusters ON topic_clusters;
DROP POLICY IF EXISTS ws_isolation_topic_clusters ON topic_clusters;
ALTER TABLE topic_clusters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE topic_clusters DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_scope_tracked_prompts ON tracked_prompts;
DROP POLICY IF EXISTS ws_isolation_tracked_prompts ON tracked_prompts;
ALTER TABLE tracked_prompts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tracked_prompts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_usage_counters ON usage_counters;
ALTER TABLE usage_counters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_usage_ledger ON usage_ledger;
ALTER TABLE usage_ledger NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_ledger DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_workspace_invitations ON workspace_invitations;
ALTER TABLE workspace_invitations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_invitations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_workspace_keys ON workspace_keys;
ALTER TABLE workspace_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_keys DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_workspace_members ON workspace_members;
ALTER TABLE workspace_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_members DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ws_isolation_workspaces ON workspaces;
ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Functions last — the partition-fix function and the three accessor
-- functions this whole migration exists to introduce.
-- ============================================================================
DROP FUNCTION IF EXISTS app.apply_tenant_rls(regclass);
DROP FUNCTION IF EXISTS app.current_scope_projects();
DROP FUNCTION IF EXISTS app.current_actor();
DROP FUNCTION IF EXISTS app.current_workspace();
