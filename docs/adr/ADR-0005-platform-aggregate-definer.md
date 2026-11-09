# ADR-0005 — The platform benchmark aggregate: one SECURITY DEFINER function, owned by a dedicated NOBYPASSRLS role

**Status:** Proposed with STORY-176 (2026-11-09; implements owner decision 91, NFR-SEC-05 option A; amended the same day for owner decision 93, benchmark privacy). It follows ADR-0002 and ADR-0004 and adds no new mechanism.

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

## Amendment — owner decision 93 (benchmark privacy)

A caller with two workspaces could override a project's category, trigger the immediate recompute, read exact percentiles and the exact sample size before and after,
and solve for another workspace's exact value. The definer now closes that, and is a second function:

7. **`app.apply_benchmark_membership()`** (no arguments; returns one integer). A project counts under `projects.benchmark_category_slug`, not its live `category_slug`.
   The function moves it to the live category, **at most once per 7 days per project** (a constant inside it, never a parameter: the runtime roles may execute it).
   The role therefore holds `UPDATE (benchmark_category_slug, benchmark_category_applied_at)` on `projects` and one `FOR UPDATE ... TO nominara_platform_agg` policy,
   declared to rls-check. During a cooldown a project keeps counting under the category it held at the last batch. A first assignment (never stamped) is free.
8. **`app.refresh_platform_metrics(from, to, categories, scoring_version)`** takes the scoring version explicitly and filters on it (`'v10'` sorts before `'v9'` as text, and
   a dual-compute would otherwise mix versions); the row records it. Percentiles and the AUX median are **rounded to whole numbers**; `top_source_domains` carries
   **no weight**, only its order. A recompute of a **past** day leaves an existing row's AUX median and domain list unchanged (they are present-day state); only the current
   UTC day takes them. `sample_size` stays exact in the table and is never on the wire: the API shows the band `"20+"`.
9. **Not a step of any workspace's rollup.** A nightly queue, `rollup.category_benchmark` (not tenant-scoped), runs the membership batch and then each category in its own short
   transaction over the last 7 UTC days, with transaction-local `lock_timeout` and `statement_timeout`. The read path serves nothing older than that window, so a category that has
   fallen below 20 answers `engines: null` rather than old figures. A failure in one category does not stop the others and fails the job after all were tried.
10. `platform_metrics` is now **read-only to the runtime roles** (`INSERT, UPDATE, DELETE, TRUNCATE` revoked from `nominara_app` and `nominara_worker`); the definer is its only writer.

Residual and follow-up: the existence of a row still flips when a category crosses 20 workspaces (one bit per batch, rate-limited by the cooldown); whether 20 workspaces under
related owners count as 20 is a follow-up (decision 93). A suspended or pending-deletion workspace is not excluded from the count, because that needs `workspaces.status`, which is
outside option A's read set: a specification change.

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
- ISO-32 (the two functions' shape) and ISO-33 (the k >= 20 rule, behaviourally, with a matching breaker) hold the control.
