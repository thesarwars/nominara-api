# ADR-0005 — The platform benchmark aggregate: one SECURITY DEFINER function, owned by a dedicated NOBYPASSRLS role

**Status:** Proposed with STORY-176 (2026-11-09; implements owner decision 91, NFR-SEC-05 option A). It follows ADR-0002 and ADR-0004 and adds no new mechanism.

## Context

`platform_metrics` holds anonymised per-category benchmarks and is global. Its inputs are not: visibility is in `metric_daily`, the category and AUX score
are in `projects`, and cited domains are in `project_source_index` and `source_domains`. All four are tenant-scoped and `FORCE ROW LEVEL SECURITY`, so a job
running in one workspace's context can read one workspace. NFR-SEC-05 said the dedicated job reads only `metric_daily`, but `metric_daily` has no
`category_slug`, no AUX score and no domains, so that wording could not be followed (decision 88). Decision 91 chose option A: the job reads the named columns
of `projects` and `project_source_index` as well, with a minimum of 20 distinct workspaces.

## Decision

1. A new role `nominara_platform_agg`: `NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, no members. It is in
   `DEFINER_OWNER_ROLES`, so `ISO-24`, `ISO-28` and `db:drift-check` cover it with no new code. It owns exactly one function.
2. `app.refresh_platform_metrics(p_from date, p_to date, p_categories text[]) RETURNS TABLE (groups_written integer, groups_removed integer)`, migration `0190`.
   `SECURITY DEFINER`, `VOLATILE`, `SET search_path = pg_catalog, pg_temp`, every relation schema-qualified. It recomputes the aggregate for those categories over
   that range, upserts every qualifying group into `platform_metrics`, and deletes what no longer qualifies. **It returns two counts and nothing else.**
3. **The read set is option A's, by column.** `SELECT` on: `metric_daily (workspace_id, project_id, engine_key, entity_type, metric_date, visibility_score, scoring_version)`,
   `projects (id, workspace_id, category_slug, aux_score_current, deleted_at)`, `project_source_index (workspace_id, project_id, source_domain_id, engine_key,
   window_start, window_days, context_weight)`, `source_domains (id, workspace_id, domain)`, `engines (key)`; and `SELECT, INSERT, UPDATE, DELETE` on
   `platform_metrics`. No table-level grant, no content column.
4. **Admitted by one role-targeted policy per table read**, `platform_aggregate_<table> ... FOR SELECT TO nominara_platform_agg USING (true)`, on the four tenant tables.
   Each is inert for every other role. Declared to `rls-check` through `computeDefinerOwnerPolicies` (`PLATFORM_AGGREGATE_TABLES`).
5. **Anonymity is enforced inside the function** (decisions 88(d) and 91): a group (date, category, engine) is published only for at least **20 distinct workspaces**; one
   workspace contributes **one** value (the median of its own projects), so an agency with many projects cannot dominate; the AUX median needs 20 workspaces with
   an AUX score; a domain is listed only when 20 distinct workspaces cite it. Below the minimum there is **no row**; the API answers null. `platform_metrics`'s own
   `CHECK (sample_size >= 20)` is the second guard.
6. `EXECUTE` is revoked from `PUBLIC` and granted to `nominara_worker`, `nominara_app` (a single-pool deployment runs workers on the application role) and
   `nominara_owner`. `nominara_report` and `nominara_portal` cannot call it. The caller supplies a date range (at most 400 days) and at most 50 category slugs, and
   cannot widen what is read.

## Alternatives considered

- **`BYPASSRLS` on the job's role (rejected).** One attribute, no policies; but it can read every tenant's rows in every table, and `ISO-07` reserves `BYPASSRLS` for
  `nominara_breakglass`.
- **Option B, `metric_daily` plus `projects.category_slug` only.** A smaller read set, but it needs `median_aux_score` and `top_source_domains` made nullable or dropped.
- **Option C, copy `category_slug` onto `metric_daily` rows.** Every override must rewrite history, and the other two columns are still unsolved.

## Consequences

- A third definer role, with one function and four policies, to be reviewed like the first two. The function is the only path by which another workspace's rows
  are read, and it cannot return them.
- `median_aux_score` is `NOT NULL`, so a group that cannot meet the AUX minimum is not published at all. Making the column nullable would let such a group publish its
  visibility figures; that is a schema change nobody has asked for (open question for the owner).
- `platform_metrics` still carries the blanket write grants of the runtime roles from migration 0004. Tightening them to read-only now that the function is the writer is
  a recommended follow-up, not done here.
