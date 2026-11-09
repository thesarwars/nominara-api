-- STORY-176 / NFR-SEC-05 option A (owner decision 91) — the cross-tenant benchmark aggregate, as ONE SECURITY DEFINER function owned by a dedicated role
-- (the ADR-0002 / ADR-0004 pattern; docs/adr/ADR-0005-platform-aggregate-definer.md). Number 0190 is reserved for this stream.
--
-- WHY. `platform_metrics` is global and anonymised, but its inputs are not: visibility lives in `metric_daily`, the category in `projects`, the AUX figure in
-- `projects`, the domains in `project_source_index` and `source_domains` — every one FORCE ROW LEVEL SECURITY and tenant-scoped. A job inside one workspace's
-- context sees only that workspace, so the aggregate cannot be computed there. Giving a role BYPASSRLS is rejected (ISO-07, ADR-0001); this is the alternative.
--
-- WHAT. nominara_platform_agg: NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, no members (ISO-24/28 cover it through DEFINER_OWNER_ROLES).
--   * COLUMN-level SELECT only, on the named columns of the four tables below (option A's read set). No table grant, no content column of `projects`
--     (name, root_url, brand_aliases, discovery...) and no `source_domains` column beyond domain.
--   * ONE FOR SELECT policy per table it reads, TO nominara_platform_agg only, USING (true); inert for every other role. Declared to rls-check through
--     computeDefinerOwnerPolicies. Plus ONE FOR UPDATE policy on projects, for the two membership columns below and nothing else.
--   * INSERT/UPDATE/DELETE on platform_metrics (the one thing it writes; the runtime roles are made READ-ONLY on it here), and SELECT (key) on engines.
--   * app.apply_benchmark_membership(): the NIGHTLY step that moves a project's BENCHMARK category to the category it holds now, once per 7 days at most.
--   * app.refresh_platform_metrics(from, to, categories, scoring_version): recomputes the aggregate for those categories over that date range from the
--     projects' benchmark categories and returns two counts. No workspace id, project id, domain or score leaves it.
--
-- THE RULES IT ENFORCES (decisions 88(d), 91 and 93):
--   * a group (date, category, engine) is published only when at least 20 DISTINCT WORKSPACES contribute; below that there is NO ROW (the read path answers null);
--   * a workspace contributes ONE value per group — the median of its own projects' scores — so an agency with many projects cannot dominate a median;
--   * the AUX median needs its own 20 workspaces with an AUX score (`median_aux_score` is NOT NULL, so a group that cannot meet it is not published);
--   * a source domain is listed only when at least 20 distinct workspaces cite it, and it is published WITHOUT its weight, only in order, so one workspace's
--     weight cannot be differenced away;
--   * only brand rows of real engines (entity_type = 'brand'; the cross-engine 'all' row has no engine) of projects that are not deleted, at the ONE scoring
--     version the caller names (never "the newest": 'v10' sorts before 'v9' as text, and a dual-compute would mix versions);
--   * THE DIFFERENCING HAZARD (decision 93): a caller with two workspaces could override a category, trigger a recompute, and read exact percentiles and an
--     exact sample size before and after, which solves for another workspace's exact value. So (a) a project counts under `benchmark_category_slug`, which
--     moves to `category_slug` ONLY in the nightly batch and at most once per 7 days (during the cooldown it keeps counting under the category it held at the
--     last batch); (b) every percentile and the AUX median are rounded to whole numbers; (c) the API shows the workspace count only as the band "20+"; (d) a
--     domain has no weight. `sample_size` stays exact in the table for the server's own use and is never on the wire.
--   * a recompute of a PAST day refreshes only its visibility figures; the AUX median and the domain list of a row that exists are the values it was published
--     with (they are present-day state, and a late recompute must not rewrite or erase them). Only the current UTC day takes them again.
-- A project's own category (`projects.category_slug`) is unaffected: the override applies to the customer's own view at once; only its contribution to the
-- cross-workspace aggregate waits for the batch.
--
-- OPERATOR NOTE: as 0005 / 0112 / 0160, the migration identity must be a SUPERUSER (ALTER ROLE ... NOSUPERUSER and ALTER FUNCTION ... OWNER TO need it).

-- The category a project COUNTS under in the cross-workspace aggregate, and when that last changed. Not constrained to the taxonomy (a value that predates the
-- taxonomy may be kept, like category_slug under migration 0189). Existing projects start with the category they hold, and no stamp, so their first change is free.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS benchmark_category_slug text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS benchmark_category_applied_at timestamptz;
UPDATE projects SET benchmark_category_slug = category_slug WHERE category_slug IS NOT NULL AND benchmark_category_slug IS NULL;
COMMENT ON COLUMN projects.benchmark_category_slug IS 'STORY-176 / decision 93: the category this project counts under in platform_metrics. Moves to category_slug only at the nightly batch (app.apply_benchmark_membership).';
COMMENT ON COLUMN projects.benchmark_category_applied_at IS 'STORY-176 / decision 93: when benchmark_category_slug last changed; NULL until its first change. A project''s membership changes at most once per 7 days.';

-- The scoring version a published row was computed from. NULL only on a row written before this migration; the function always writes it.
ALTER TABLE platform_metrics ADD COLUMN IF NOT EXISTS scoring_version text;

-- platform_metrics is written by the definer alone (decision 91). Runs after ALTER DEFAULT PRIVILEGES (0005), which granted the two write-capable roles full DML.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_metrics FROM nominara_app, nominara_worker;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_platform_agg') THEN
    CREATE ROLE nominara_platform_agg NOLOGIN NOINHERIT;
  END IF;
END $$;
ALTER ROLE nominara_platform_agg NOLOGIN NOINHERIT CONNECTION LIMIT -1 NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT r.rolname::text AS role_name, gr.rolname::text AS grantor_name
      FROM pg_auth_members am
      JOIN pg_roles m ON m.oid = am.member
      JOIN pg_roles r ON r.oid = am.roleid
      JOIN pg_roles gr ON gr.oid = am.grantor
     WHERE m.rolname = 'nominara_platform_agg'
  LOOP
    EXECUTE format('REVOKE %I FROM nominara_platform_agg GRANTED BY %I', g.role_name, g.grantor_name);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO nominara_platform_agg;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_platform_agg;
GRANT SELECT (workspace_id, project_id, engine_key, entity_type, metric_date, visibility_score, scoring_version) ON metric_daily          TO nominara_platform_agg;
GRANT SELECT (id, workspace_id, category_slug, benchmark_category_slug, benchmark_category_applied_at, aux_score_current, deleted_at) ON projects TO nominara_platform_agg;
GRANT UPDATE (benchmark_category_slug, benchmark_category_applied_at)                                              ON projects              TO nominara_platform_agg;
GRANT SELECT (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight) ON project_source_index  TO nominara_platform_agg;
GRANT SELECT (id, workspace_id, domain)                                                                           ON source_domains        TO nominara_platform_agg;
GRANT SELECT (key)                                                                                                ON engines               TO nominara_platform_agg;
GRANT SELECT, INSERT, UPDATE, DELETE                                                                              ON platform_metrics      TO nominara_platform_agg;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['metric_daily', 'projects', 'project_source_index', 'source_domains'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'platform_aggregate_' || t) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO nominara_platform_agg USING (true)', 'platform_aggregate_' || t, t);
    END IF;
  END LOOP;
END $$;

-- The one write it makes to a tenant table: the two membership columns (the UPDATE grant above is column-level). Declared to rls-check like the SELECT policies.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects' AND policyname = 'platform_aggregate_projects_membership') THEN
    CREATE POLICY platform_aggregate_projects_membership ON public.projects FOR UPDATE TO nominara_platform_agg USING (true) WITH CHECK (true);
  END IF;
END $$;

-- A reading by the planner only: groups are found by benchmark category, so projects needs an index on it (a partial one, as the soft-delete convention asks).
CREATE INDEX IF NOT EXISTS ix_projects_benchmark_category ON projects (benchmark_category_slug) WHERE deleted_at IS NULL AND benchmark_category_slug IS NOT NULL;

-- The nightly membership step. The 7-day cooldown is a constant HERE, not an argument: the function is executable by the runtime roles, and a caller-supplied
-- cooldown would be one they could set to zero. A project is moved only when its category differs from the one it counts under AND it has not changed in the last
-- 7 days; a project that has never changed (NULL stamp) is free to. It moves to the category it holds NOW, however many times that changed in between.
CREATE OR REPLACE FUNCTION app.apply_benchmark_membership()
RETURNS TABLE (projects_moved integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, MDY'
AS $$
DECLARE
  c_cooldown constant interval := interval '7 days';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('platform_metrics:membership', 0));
  WITH moved AS (
    UPDATE public.projects p
       SET benchmark_category_slug = p.category_slug,
           benchmark_category_applied_at = now()
     WHERE p.deleted_at IS NULL
       AND p.benchmark_category_slug IS DISTINCT FROM p.category_slug
       AND (p.benchmark_category_applied_at IS NULL OR p.benchmark_category_applied_at <= now() - c_cooldown)
    RETURNING 1
  )
  SELECT count(*)::integer INTO projects_moved FROM moved;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION app.refresh_platform_metrics(p_from date, p_to date, p_categories text[], p_scoring_version text)
RETURNS TABLE (groups_written integer, groups_removed integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, MDY'
AS $$
DECLARE
  -- Decision 88(d) / NFR-SEC-05: the minimum number of distinct contributing workspaces. platform_metrics' own CHECK (sample_size >= 20) is the second guard.
  c_min_workspaces constant integer := 20;
  c_top_domains    constant integer := 10;
  c_max_days       constant integer := 400;
  c_max_categories constant integer := 50;
  v_category text;
  -- Decision 93: the day on which AUX and the domain list are refreshed. Any earlier day keeps what its row was published with.
  v_today    constant date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_categories IS NULL OR p_scoring_version IS NULL OR p_scoring_version = '' THEN
    RAISE EXCEPTION 'refresh_platform_metrics: p_from, p_to, p_categories and p_scoring_version must not be null or empty';
  END IF;
  IF p_to < p_from OR p_to - p_from > c_max_days THEN
    RAISE EXCEPTION 'refresh_platform_metrics: the date range must run forward and span at most % days', c_max_days;
  END IF;
  IF cardinality(p_categories) > c_max_categories THEN
    RAISE EXCEPTION 'refresh_platform_metrics: at most % categories per call', c_max_categories;
  END IF;
  groups_written := 0;
  groups_removed := 0;
  IF cardinality(p_categories) = 0 THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Two recomputes of one category would race on the same keys. Serialised per category, in sorted order so two calls cannot deadlock.
  FOR v_category IN SELECT DISTINCT c FROM unnest(p_categories) AS c WHERE c IS NOT NULL ORDER BY c LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('platform_metrics:' || v_category, 0));
  END LOOP;

  WITH proj AS (
    -- The BENCHMARK category: what the project counts under since the last nightly batch, not the category it holds now.
    SELECT p.id, p.workspace_id, p.benchmark_category_slug AS category_slug, p.aux_score_current
      FROM public.projects p
     WHERE p.benchmark_category_slug = ANY (p_categories) AND p.deleted_at IS NULL
  ),
  -- One visibility figure per project, engine and day, at EXACTLY the requested scoring version. Never "the newest": version strings sort as text.
  vis AS (
    SELECT m.project_id, m.engine_key, m.metric_date, m.visibility_score
      FROM public.metric_daily m
      JOIN proj ON proj.id = m.project_id
      JOIN public.engines e ON e.key = m.engine_key
     WHERE m.entity_type = 'brand' AND m.metric_date BETWEEN p_from AND p_to AND m.scoring_version = p_scoring_version
  ),
  -- ONE value per workspace per group.
  ws_vis AS (
    SELECT proj.category_slug, v.engine_key, v.metric_date, proj.workspace_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY v.visibility_score) AS visibility
      FROM vis v JOIN proj ON proj.id = v.project_id
     GROUP BY proj.category_slug, v.engine_key, v.metric_date, proj.workspace_id
  ),
  ws_aux AS (
    SELECT category_slug, workspace_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY aux_score_current) AS aux
      FROM proj WHERE aux_score_current IS NOT NULL
     GROUP BY category_slug, workspace_id
  ),
  groups AS (
    SELECT v.category_slug, v.engine_key, v.metric_date,
           count(*)::integer AS k,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY v.visibility) AS med,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY v.visibility) AS p25,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY v.visibility) AS p75,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY a.aux)        AS med_aux
      FROM ws_vis v
      LEFT JOIN ws_aux a ON a.category_slug = v.category_slug AND a.workspace_id = v.workspace_id
     GROUP BY v.category_slug, v.engine_key, v.metric_date
    HAVING count(*) >= c_min_workspaces AND count(a.aux) >= c_min_workspaces
  ),
  -- Per contributing workspace and domain: the workspace's mean share of citation context, from each project's newest 90-day window at or before the day.
  dom_ws AS (
    SELECT g.category_slug, g.engine_key, g.metric_date, sd.domain, pr.workspace_id, avg(x.context_weight) AS w
      FROM groups g
      JOIN proj pr ON pr.category_slug = g.category_slug
      JOIN ws_vis v ON v.category_slug = g.category_slug AND v.engine_key = g.engine_key AND v.metric_date = g.metric_date AND v.workspace_id = pr.workspace_id
      CROSS JOIN LATERAL (
        SELECT i.source_domain_id, i.context_weight
          FROM public.project_source_index i
         WHERE i.project_id = pr.id AND i.engine_key = g.engine_key AND i.window_days = 90
           AND i.window_start = (SELECT max(i2.window_start) FROM public.project_source_index i2
                                  WHERE i2.project_id = pr.id AND i2.engine_key = g.engine_key AND i2.window_days = 90 AND i2.window_start <= g.metric_date)
      ) x
      JOIN public.source_domains sd ON sd.id = x.source_domain_id
     GROUP BY g.category_slug, g.engine_key, g.metric_date, sd.domain, pr.workspace_id
  ),
  dom AS (
    SELECT category_slug, engine_key, metric_date, domain, avg(w) AS weight
      FROM dom_ws
     GROUP BY category_slug, engine_key, metric_date, domain
    HAVING count(*) >= c_min_workspaces
  ),
  top AS (
    SELECT category_slug, engine_key, metric_date,
           jsonb_agg(jsonb_build_object('domain', domain) ORDER BY weight DESC, domain) AS domains
      FROM (SELECT d.*, row_number() OVER (PARTITION BY category_slug, engine_key, metric_date ORDER BY weight DESC, domain) AS n FROM dom d) r
     WHERE n <= c_top_domains
     GROUP BY category_slug, engine_key, metric_date
  ),
  upserted AS (
    INSERT INTO public.platform_metrics
      (metric_date, category_slug, engine_key, sample_size, scoring_version, median_visibility, p25_visibility, p75_visibility, median_aux_score, top_source_domains)
    SELECT g.metric_date, g.category_slug, g.engine_key, g.k, p_scoring_version,
           round(g.med::numeric, 0), round(g.p25::numeric, 0), round(g.p75::numeric, 0), round(g.med_aux::numeric, 0),
           coalesce(t.domains, '[]'::jsonb)
      FROM groups g
      LEFT JOIN top t ON t.category_slug = g.category_slug AND t.engine_key = g.engine_key AND t.metric_date = g.metric_date
    ON CONFLICT (metric_date, category_slug, engine_key) DO UPDATE SET
      sample_size = EXCLUDED.sample_size,
      scoring_version = EXCLUDED.scoring_version,
      median_visibility = EXCLUDED.median_visibility,
      p25_visibility = EXCLUDED.p25_visibility,
      p75_visibility = EXCLUDED.p75_visibility,
      -- A past day keeps the AUX median and the domains it was published with: both are present-day state, and recomputing history from it would rewrite or erase them.
      median_aux_score = CASE WHEN EXCLUDED.metric_date >= v_today THEN EXCLUDED.median_aux_score ELSE platform_metrics.median_aux_score END,
      top_source_domains = CASE WHEN EXCLUDED.metric_date >= v_today THEN EXCLUDED.top_source_domains ELSE platform_metrics.top_source_domains END
    RETURNING 1
  ),
  -- What was published for these categories and days but no longer qualifies (a project moved out, the group fell below 20): no stale value remains.
  removed AS (
    DELETE FROM public.platform_metrics pm
     WHERE pm.metric_date BETWEEN p_from AND p_to
       AND pm.category_slug = ANY (p_categories)
       AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.metric_date = pm.metric_date AND g.category_slug = pm.category_slug AND g.engine_key = pm.engine_key)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM upserted)::integer, (SELECT count(*) FROM removed)::integer
    INTO groups_written, groups_removed;
  RETURN NEXT;
END;
$$;

GRANT CREATE ON SCHEMA app TO nominara_platform_agg;
ALTER FUNCTION app.refresh_platform_metrics(date, date, text[], text) OWNER TO nominara_platform_agg;
ALTER FUNCTION app.apply_benchmark_membership() OWNER TO nominara_platform_agg;
REVOKE CREATE ON SCHEMA app FROM nominara_platform_agg;

REVOKE ALL ON FUNCTION app.refresh_platform_metrics(date, date, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_benchmark_membership() FROM PUBLIC;
-- The nightly job runs as the worker (or, in a single-pool deployment, the application role); nominara_owner is the operator. Never report or portal.
GRANT EXECUTE ON FUNCTION app.refresh_platform_metrics(date, date, text[], text) TO nominara_worker, nominara_app, nominara_owner;
GRANT EXECUTE ON FUNCTION app.apply_benchmark_membership() TO nominara_worker, nominara_app, nominara_owner;

COMMENT ON FUNCTION app.refresh_platform_metrics(date, date, text[], text) IS
  'STORY-176 / NFR-SEC-05 option A: recomputes platform_metrics for the given categories and days, at one named scoring version, from the named columns of metric_daily, projects, project_source_index and source_domains. Publishes a group only for >= 20 distinct workspaces; one value per workspace; percentiles rounded to whole numbers; domains without weights. Returns two counts. SECURITY DEFINER owned by nominara_platform_agg. ADR-0005.';
COMMENT ON FUNCTION app.apply_benchmark_membership() IS
  'STORY-176 / decision 93: the nightly batch that moves each project''s benchmark category to the category it holds now, at most once per 7 days per project. Returns a count. SECURITY DEFINER owned by nominara_platform_agg. ADR-0005.';
