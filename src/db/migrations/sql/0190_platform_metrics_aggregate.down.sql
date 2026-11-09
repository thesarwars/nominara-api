-- STORY-176 — rollback of 0190_platform_metrics_aggregate. LOSSY for nothing that cannot be recomputed: platform_metrics rows are derived and are recomputed by the
-- nightly job once the functions are back, and the two projects columns hold only a copy of category_slug and a stamp. platform_metrics rows are left in place.
-- Drops both functions, the four read policies and the membership update policy, the index, the two projects columns, platform_metrics.scoring_version, the grants and
-- the role's table privileges, and gives nominara_app / nominara_worker back the write grants on platform_metrics that 0005's blanket default had applied
-- (the round-trip gate compares ACLs). It does NOT drop the role itself, which is cluster-wide and may be shared with a rolled-forward database.
DROP FUNCTION IF EXISTS app.refresh_platform_metrics(date, date, text[], text);
DROP FUNCTION IF EXISTS app.apply_benchmark_membership();
DROP POLICY IF EXISTS platform_aggregate_metric_daily ON public.metric_daily;
DROP POLICY IF EXISTS platform_aggregate_projects ON public.projects;
DROP POLICY IF EXISTS platform_aggregate_projects_membership ON public.projects;
DROP POLICY IF EXISTS platform_aggregate_project_source_index ON public.project_source_index;
DROP POLICY IF EXISTS platform_aggregate_source_domains ON public.source_domains;
DROP INDEX IF EXISTS ix_projects_benchmark_category;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_platform_agg;
REVOKE USAGE ON SCHEMA public FROM nominara_platform_agg;
ALTER TABLE projects DROP COLUMN IF EXISTS benchmark_category_applied_at;
ALTER TABLE projects DROP COLUMN IF EXISTS benchmark_category_slug;
ALTER TABLE platform_metrics DROP COLUMN IF EXISTS scoring_version;
GRANT INSERT, UPDATE, DELETE ON platform_metrics TO nominara_app, nominara_worker;
