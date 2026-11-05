-- STORY-013 round 2 / owner decision 58(a) — three COUNT-ONLY SECURITY DEFINER functions owned by a DEDICATED role
-- (docs/adr/ADR-0004-maintenance-count-only-definer.md; the ADR-0002 pattern). Number 0160 is reserved for this stream.
--
-- WHY. The nightly integrity checks (orphan scan, default-partition row count, vector-recall check) read tenant tables across every
-- workspace. All of those tables are FORCE ROW LEVEL SECURITY, and the documented production maintenance identity is NOSUPERUSER
-- NOBYPASSRLS, so on it the checks read zero rows and look clean. Giving that identity BYPASSRLS is rejected (ISO-07, ADR-0001).
--
-- WHAT. nominara_maintenance: NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION. No role is a
-- member of it (ISO-24 via DEFINER_OWNER_ROLES), so its rights are exercised only by calling the functions.
--   * COLUMN-level SELECT only, on seven tables, on key columns only (no table grant, no write, no content column).
--   * ONE FOR SELECT policy per table it reads, TO nominara_maintenance only, USING (true). The functions read the PARENT tables, so
--     no per-partition policy is needed as months are added. Declared to rls-check via computeDefinerOwnerPolicies.
--   * app.maintenance_default_partition_rows(), app.maintenance_orphan_counts(), app.maintenance_recall_overlap(text, halfvec, int):
--     every output column is text (a table or partition NAME), bigint or integer. SET search_path = pg_catalog, pg_temp.
--     EXECUTE revoked from PUBLIC and granted to nominara_owner only: the maintenance connection, never a runtime role.
--
-- OPERATOR NOTE: as 0005 / 0112, the migration identity must be a SUPERUSER (ALTER ROLE ... NOSUPERUSER and ALTER FUNCTION ... OWNER
-- TO need it). A failed apply aborts and fails closed.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_maintenance') THEN
    CREATE ROLE nominara_maintenance NOLOGIN NOINHERIT;
  END IF;
END $$;
-- Converging, as 0005 / 0112: re-state every attribute so a pre-existing role (e.g. one hand-given BYPASSRLS) cannot keep it.
ALTER ROLE nominara_maintenance NOLOGIN NOINHERIT CONNECTION LIMIT -1
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT USAGE ON SCHEMA public TO nominara_maintenance;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_maintenance;
GRANT SELECT (id, workspace_id, captured_at)          ON answer_captures TO nominara_maintenance;
GRANT SELECT (workspace_id, result_id, captured_at)   ON mention_facts   TO nominara_maintenance;
GRANT SELECT (workspace_id, result_id, captured_at)   ON citation_facts  TO nominara_maintenance;
GRANT SELECT (id, embedding)                          ON tracked_prompts TO nominara_maintenance;
GRANT SELECT (id, centroid)                           ON topic_clusters  TO nominara_maintenance;
GRANT SELECT (id, embedding)                          ON content_chunks  TO nominara_maintenance;
GRANT SELECT (id, embedding)                          ON corpus_passages TO nominara_maintenance;

-- One role-targeted SELECT policy per table. Permissive policies combine per role, so each contributes nothing to any other role.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['answer_captures', 'mention_facts', 'citation_facts', 'tracked_prompts', 'topic_clusters', 'content_chunks', 'corpus_passages'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'maintenance_count_' || t) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO nominara_maintenance USING (true)', 'maintenance_count_' || t, t);
    END IF;
  END LOOP;
END $$;

-- ⚠ NO SYSTEM COLUMN. A column-level SELECT grant does not cover `tableoid` / `ctid` (Postgres falls back to a TABLE-level check for
-- them, and this role must not hold one), so a partition is identified by its RANGE BOUNDS, read from pg_class.relpartbound and applied
-- as a predicate on captured_at (the partition key) through the PARENT. The DEFAULT partition is "no sibling's range", which is
-- exactly its partition constraint. A bound that cannot be parsed RAISES; it never becomes an empty predicate.

-- 1. Default-partition row counts: one row per partitioned fact table, ZERO INCLUDED. A default partition that is missing, detached or
--    not a DEFAULT partition RAISES; it is never a clean 0.
CREATE OR REPLACE FUNCTION app.maintenance_default_partition_rows()
RETURNS TABLE (parent_table text, default_partition text, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_parent     text;
  v_parent_oid regclass;
  v_part       regclass;
  v_ranges     text;
  v_unparsed   integer;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['answer_captures', 'mention_facts', 'citation_facts'] LOOP
    v_parent_oid := to_regclass(format('public.%I', v_parent));
    v_part := to_regclass(format('public.%I', v_parent || '_default'));
    IF v_parent_oid IS NULL OR v_part IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhrelid = v_part AND i.inhparent = v_parent_oid AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
       ) THEN
      RAISE EXCEPTION 'maintenance: public.% is not attached as the DEFAULT partition of public.%', v_parent || '_default', v_parent;
    END IF;

    SELECT string_agg(format('(f.captured_at >= %L::timestamptz AND f.captured_at < %L::timestamptz)', r.m[1], r.m[2]), ' OR '),
           count(*) FILTER (WHERE r.m IS NULL)
      INTO v_ranges, v_unparsed
      FROM (SELECT regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM [(]''([^'']+)''[)] TO [(]''([^'']+)''[)]') AS m
              FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = v_parent_oid AND c.relkind = 'r' AND c.oid <> v_part) r;
    IF v_unparsed > 0 THEN
      RAISE EXCEPTION 'maintenance: a partition bound of public.% could not be read', v_parent;
    END IF;

    parent_table := v_parent;
    default_partition := v_parent || '_default';
    EXECUTE format('SELECT count(*) FROM public.%I f WHERE NOT (%s)', v_parent, coalesce(v_ranges, 'false')) INTO row_count;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 2. Orphan counts: fact rows with no parent capture in the SAME workspace and at the SAME captured_at, per partition. Only partitions
--    with at least one orphan are returned. Counts and partition names only.
CREATE OR REPLACE FUNCTION app.maintenance_orphan_counts()
RETURNS TABLE (parent_table text, partition_name text, orphan_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_parent     text;
  v_parent_oid regclass;
  v_child      record;
  v_all_ranges text;
  v_pred       text;
  v_unparsed   integer;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['mention_facts', 'citation_facts'] LOOP
    v_parent_oid := to_regclass(format('public.%I', v_parent));
    IF v_parent_oid IS NULL THEN
      RAISE EXCEPTION 'maintenance: public.% does not exist', v_parent;
    END IF;

    SELECT string_agg(format('(f.captured_at >= %L::timestamptz AND f.captured_at < %L::timestamptz)', r.m[1], r.m[2]), ' OR '),
           count(*) FILTER (WHERE r.m IS NULL AND r.bound <> 'DEFAULT')
      INTO v_all_ranges, v_unparsed
      FROM (SELECT pg_get_expr(c.relpartbound, c.oid) AS bound,
                   regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM [(]''([^'']+)''[)] TO [(]''([^'']+)''[)]') AS m
              FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             WHERE i.inhparent = v_parent_oid AND c.relkind = 'r') r;
    IF v_unparsed > 0 THEN
      RAISE EXCEPTION 'maintenance: a partition bound of public.% could not be read', v_parent;
    END IF;

    FOR v_child IN
      SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound,
             regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM [(]''([^'']+)''[)] TO [(]''([^'']+)''[)]') AS m
        FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = v_parent_oid AND c.relkind = 'r'
       ORDER BY c.relname
    LOOP
      IF v_child.bound = 'DEFAULT' THEN
        v_pred := format('NOT (%s)', coalesce(v_all_ranges, 'false'));
      ELSE
        v_pred := format('f.captured_at >= %L::timestamptz AND f.captured_at < %L::timestamptz', v_child.m[1], v_child.m[2]);
      END IF;
      EXECUTE format(
        'SELECT count(*) FROM public.%I f WHERE %s AND NOT EXISTS (SELECT 1 FROM public.answer_captures a WHERE a.id = f.result_id AND a.captured_at = f.captured_at AND a.workspace_id = f.workspace_id)',
        v_parent, v_pred) INTO orphan_count;
      IF orphan_count > 0 THEN
        parent_table := v_parent;
        partition_name := v_child.name;
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- 3. Recall inputs: how many non-null vectors the table holds, and how many of the index's top-k equal the exact top-k for ONE query
--    vector. Both sets are built and compared INSIDE the function; no id and no vector leaves it. The table name must be one of the four
--    HNSW tables (its column is looked up, never taken from the caller); k is bounded. overlap is NULL when fewer than k vectors exist
--    (too few to measure: null is not 0).
CREATE OR REPLACE FUNCTION app.maintenance_recall_overlap(p_table text, p_query halfvec, p_k integer)
RETURNS TABLE (candidate_rows bigint, overlap integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_col      text;
  v_ann      uuid[];
  v_exact    uuid[];
  v_prev_idx text;
  v_prev_bmp text;
BEGIN
  v_col := CASE p_table
    WHEN 'tracked_prompts' THEN 'embedding'
    WHEN 'topic_clusters'  THEN 'centroid'
    WHEN 'content_chunks'  THEN 'embedding'
    WHEN 'corpus_passages' THEN 'embedding'
  END;
  IF v_col IS NULL THEN
    RAISE EXCEPTION 'maintenance_recall_overlap: p_table is not an allowed table';
  END IF;
  IF p_k IS NULL OR p_k < 1 OR p_k > 100 THEN
    RAISE EXCEPTION 'maintenance_recall_overlap: p_k must be between 1 and 100';
  END IF;
  IF p_query IS NULL THEN
    RAISE EXCEPTION 'maintenance_recall_overlap: p_query must not be null';
  END IF;

  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL', p_table, v_col) INTO candidate_rows;
  IF candidate_rows < p_k THEN
    overlap := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- `<=>` (cosine) to match the *_cosine_ops HNSW indexes: the planner only considers the index when the operator matches the opclass.
  EXECUTE format('SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) FROM (SELECT id FROM public.%1$I WHERE %2$I IS NOT NULL ORDER BY %2$I OPERATOR(public.<=>) $1 LIMIT $2) s', p_table, v_col)
    INTO v_ann USING p_query, p_k;

  v_prev_idx := current_setting('enable_indexscan');
  v_prev_bmp := current_setting('enable_bitmapscan');
  PERFORM set_config('enable_indexscan', 'off', true);
  PERFORM set_config('enable_bitmapscan', 'off', true);
  EXECUTE format('SELECT coalesce(array_agg(s.id), ARRAY[]::uuid[]) FROM (SELECT id FROM public.%1$I WHERE %2$I IS NOT NULL ORDER BY %2$I OPERATOR(public.<=>) $1 LIMIT $2) s', p_table, v_col)
    INTO v_exact USING p_query, p_k;
  PERFORM set_config('enable_indexscan', v_prev_idx, true);
  PERFORM set_config('enable_bitmapscan', v_prev_bmp, true);

  SELECT count(*)::integer INTO overlap FROM unnest(v_ann) AS a(id) WHERE a.id = ANY (v_exact);
  RETURN NEXT;
END;
$$;

-- Hand the functions to the dedicated role. Ownership transfer needs the new owner to hold CREATE on the schema.
GRANT CREATE ON SCHEMA app TO nominara_maintenance;
ALTER FUNCTION app.maintenance_default_partition_rows() OWNER TO nominara_maintenance;
ALTER FUNCTION app.maintenance_orphan_counts() OWNER TO nominara_maintenance;
ALTER FUNCTION app.maintenance_recall_overlap(text, halfvec, integer) OWNER TO nominara_maintenance;
REVOKE CREATE ON SCHEMA app FROM nominara_maintenance;

REVOKE ALL ON FUNCTION app.maintenance_default_partition_rows() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.maintenance_orphan_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.maintenance_recall_overlap(text, halfvec, integer) FROM PUBLIC;
-- nominara_owner owns schema app in production; elsewhere (a superuser-owned schema) it needs USAGE to resolve app.maintenance_*.
GRANT USAGE ON SCHEMA app TO nominara_owner;
GRANT EXECUTE ON FUNCTION app.maintenance_default_partition_rows() TO nominara_owner;
GRANT EXECUTE ON FUNCTION app.maintenance_orphan_counts() TO nominara_owner;
GRANT EXECUTE ON FUNCTION app.maintenance_recall_overlap(text, halfvec, integer) TO nominara_owner;

COMMENT ON FUNCTION app.maintenance_default_partition_rows() IS
  'Row count of each fact table''s DEFAULT partition (0 included; raises if it is missing). COUNT-ONLY SECURITY DEFINER owned by nominara_maintenance; EXECUTE for nominara_owner only. ADR-0004.';
COMMENT ON FUNCTION app.maintenance_orphan_counts() IS
  'Per-partition count of mention_facts / citation_facts rows with no parent answer_captures row in the same workspace. COUNT-ONLY SECURITY DEFINER owned by nominara_maintenance; EXECUTE for nominara_owner only. ADR-0004.';
COMMENT ON FUNCTION app.maintenance_recall_overlap(text, halfvec, integer) IS
  'Non-null vector count and top-k ANN/exact overlap for one HNSW table and one query vector. COUNT-ONLY SECURITY DEFINER owned by nominara_maintenance; EXECUTE for nominara_owner only. ADR-0004.';
