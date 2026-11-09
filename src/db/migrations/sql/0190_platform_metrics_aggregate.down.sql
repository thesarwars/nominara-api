-- STORY-176 — rollback of 0190_platform_metrics_aggregate. LOSSY for nothing: platform_metrics rows are derived and are recomputed by the next rollups once the
-- function is back; here they are left in place (the table is unchanged). Drops the function, the four read policies, the index, the grants and the role.
DROP FUNCTION IF EXISTS app.refresh_platform_metrics(date, date, text[]);
DROP POLICY IF EXISTS platform_aggregate_metric_daily ON public.metric_daily;
DROP POLICY IF EXISTS platform_aggregate_projects ON public.projects;
DROP POLICY IF EXISTS platform_aggregate_project_source_index ON public.project_source_index;
DROP POLICY IF EXISTS platform_aggregate_source_domains ON public.source_domains;
DROP INDEX IF EXISTS ix_projects_category;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_platform_agg;
REVOKE USAGE ON SCHEMA public FROM nominara_platform_agg;
