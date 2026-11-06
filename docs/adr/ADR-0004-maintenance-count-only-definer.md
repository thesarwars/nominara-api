# ADR-0004 — Count-only SECURITY DEFINER functions, owned by a dedicated NOBYPASSRLS role, for the nightly integrity checks

**Status:** Proposed (implements owner decision 58(a) of 2026-11-05; needs the auditor's sign-off before it is Accepted)

## Context

STORY-013 added `maintenance.integrity` (03:10 UTC) and the default-partition alert in `maintenance.partition`. Their checks read
tenant tables across every workspace: the orphan scan anti-joins `mention_facts` / `citation_facts` against `answer_captures`, the
default-partition count reads the `*_default` partitions, and the vector-recall check reads the four HNSW tables. Every one of those
tables is `FORCE ROW LEVEL SECURITY` (`0006`), and the documented production maintenance identity (`nominara_owner`,
security-and-tenancy.md section 2) is `NOSUPERUSER NOBYPASSRLS`. On that role the checks read zero rows without an error, which
presents as "no orphans", "nothing stranded" and "nothing to measure" every night.

Review round 1 made them fail closed (`assertCanSeeTenantRows`: the job rejects unless the role is a superuser or `BYPASSRLS`). That
is honest, but it means the checks do not work under the documented production role at all. Owner decision 58(a): give them
visibility through a count-only `SECURITY DEFINER` function owned by a dedicated maintenance role, admitted by a role-targeted policy,
following ADR-0002.

## Decision

1. A new role `nominara_maintenance`: `NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`. No role is a
   member of it. It owns exactly three functions. It is registered in `DEFINER_OWNER_ROLES`, so `ISO-24` (no members, no
   `pg_has_role` reach) and `db:drift-check` cover it with no new code.
2. Three functions in schema `app`, migration `0160`, all `SECURITY DEFINER`, `STABLE`, `SET search_path = pg_catalog, pg_temp`, every
   relation schema-qualified:
   - `app.maintenance_default_partition_rows()` returns `(parent_table text, default_partition text, row_count bigint)`, one row per
     partitioned fact table, `0` included. A missing default partition raises; it never reads as `0`.
   - `app.maintenance_orphan_counts()` returns `(parent_table text, partition_name text, orphan_count bigint)`, only for partitions
     with at least one orphan.
   - `app.maintenance_recall_overlap(p_table text, p_query halfvec, p_k integer)` returns `(candidate_rows bigint, overlap integer)`:
     how many non-null vectors the table holds, and how many of the index's top-k equal the exact top-k. Both sets are built and
     compared inside the function; no id or vector leaves it.
3. **Counts only, structurally.** Output columns are `text` (a table or partition name, never a row value), `bigint` and `integer`.
   The first two take no argument. The third takes a vector to search with and a table name that must be one of the four HNSW
   tables; any other value (a predicate, a schema-qualified name, another table) raises. `p_k` is bounded to 1..100. The functions
   have no `WHERE` the caller can influence, and the owner has no column the output could be built from beyond the key columns below.
   Enforced by integration cases MD-2, MD-2b and `ISO-27`.
4. **Admitted by one role-targeted policy per table read**, `maintenance_count_<table> ... FOR SELECT TO nominara_maintenance USING (true)`,
   on `answer_captures`, `mention_facts`, `citation_facts`, `tracked_prompts`, `topic_clusters`, `content_chunks` and `corpus_passages`
   (seven policies; the pattern is one per table, as `ws_isolation_*` is). Each is inert for every other role (permissive policies
   combine per role). The functions read the PARENT tables, so the policies sit on the parents and no per-partition policy is needed
   as new months are created (`app.apply_tenant_rls` copies only `ws_isolation_*`). They are hand-written in `0160` and declared to
   `src/db/rls/rls-check.ts` through `computeDefinerOwnerPolicies`, so rls-check expects them and still flags every other
   undeclared policy.
5. **Reach bounded by grants, not by the policies.** `SELECT` on named columns only, no table grant, no write, no other table:
   `answer_captures (id, workspace_id, captured_at)`, `mention_facts` / `citation_facts (workspace_id, result_id, captured_at)`, and
   `(id, <vector column>)` on the four HNSW tables. Content columns (`entity_label`, `text`, `url`, ...) are unreadable to the owner.
6. `EXECUTE` is revoked from `PUBLIC` and granted to **`nominara_owner` only**: the maintenance connection is the owner identity
   (or a login role that inherits it), never a runtime role. `nominara_app`, `nominara_worker`, `nominara_report` and
   `nominara_portal` cannot call them (`42501`).
7. The handlers replace `assertCanSeeTenantRows` with "the three functions exist and are executable by this connection". If not, the
   job fails closed exactly as before (`nominara_maintenance_integrity_check_errors_total{check="definer_function"}`, an error log, a
   rejected job, no `0` and no skip observed). `purge_failures` is global with no RLS and no runtime grant; it is still read directly
   and needs no definer.

## Alternatives considered

- **Give the maintenance identity `BYPASSRLS` (rejected).** One attribute, no policies, no functions. But it makes the identity that
  runs a nightly job able to read every tenant's rows in every table, and `ISO-07` and ADR-0001 reserve `BYPASSRLS` for
  `nominara_breakglass` alone, an exception that is audited. ADR-0001 and ADR-0002 already rejected "give the definer `BYPASSRLS`".
- **Run the checks as a superuser (rejected).** The same reach and more; it is what the tests did, which is why the gap was invisible.
- **Per-workspace loop with `app.current_workspace()` set (rejected).** Correct but the orphan scan becomes N statements over the
  fact tables, the default partition and the vector index are not workspace-shaped, and the loop needs a list of workspaces from a
  table the job should not need to enumerate.
- **A policy on each partition (rejected).** Needs a new policy per monthly partition and a change to `app.apply_tenant_rls`; the
  parent-level policy covers every current and future partition.
- **One function with a "check name" switch (rejected).** A string that selects behaviour is the shape a predicate would hide in.

## Consequences

- The three checks report the true counts under `NOSUPERUSER NOBYPASSRLS`. The same wrappers serve the operator scripts, which keep
  working on a superuser connection.
- **A partition is identified by its range bounds, not by `tableoid`.** A column-level `SELECT` grant does not cover system columns
  (`tableoid`, `ctid`: Postgres falls back to a table-level check, which this role must not hold), so the functions read
  `pg_class.relpartbound` and apply each partition's range as a predicate on `captured_at` through the parent; the DEFAULT
  partition is "outside every sibling's range", which is its partition constraint. An unreadable bound raises. Partition pruning
  keeps each per-partition count to its own partition. The default-partition count scans the parent once per fact table at each
  run (the orphan scan already does that nightly). Two bounds, neither of them a function-level `SET statement_timeout`, which would
  bound nothing: the timer is armed when the top-level statement starts, and a `SET` on a function applies after that. The bound is on
  the CALL: `detectDefaultPartitionRows` runs the count in its own short transaction under `SET LOCAL statement_timeout`
  (`DEFAULT_PARTITION_COUNT_TIMEOUT_MS`, 60 s; MD-12 shows a blocked count failing with `57014` and the setting not leaking). And the
  scan is shown to read only the `*_default` partitions (MD-11, via `pg_stat_xact_user_tables`), not every month.
- Seven more policies exist on tenant tables, all for one NOLOGIN role that nobody can assume. Any further definer-owner needs its
  own ADR; this one does not generalise.
- The migration identity must be a SUPERUSER, as for `0005` and `0112` (`ALTER FUNCTION ... OWNER TO` and `ALTER ROLE ... NOSUPERUSER`
  need it). A failed apply aborts and fails closed.
- `EXECUTE` is granted to the role name `nominara_owner`. **Go-live item G-4:** the production maintenance login must be a member of
  `nominara_owner` `WITH INHERIT TRUE` (PG16+ decides INHERIT per grant), or the code must `SET ROLE nominara_owner` first. Until
  that is settled the nightly checks fail closed (`check="definer_function"`), they never read a false 0. README G-4 remains an
  operator decision.
- **The down revokes `USAGE ON SCHEMA app` from `nominara_owner` only if the up granted it.** The owner already holds it in production
  and `createPartition` calls `app.apply_tenant_rls()` through it; a blanket revoke would break partition creation. The up grants only
  when the owner lacks USAGE and leaves a marker in the comment of `app.maintenance_default_partition_rows()`; the down reads that
  marker before it drops the function (MD-9b; `db:roundtrip-check` covers the case where the up did grant).
- **Effective EXECUTE is asserted too (ISO-29).** An ACL lists grantees, not who can act as them: a runtime role made a member of `nominara_owner` executes through it. ISO-29 names the roles to refuse (runtime roles, the share-lookup role, a non-BYPASSRLS break-glass role), never filtering by prefix because the G-4 login is a legitimate member, and checks, for each refused role, the role itself plus every role it is a MEMBER of (`pg_has_role(r, Y, 'MEMBER')`: INHERIT, SET-only, ADMIN-only, any chain) with `has_function_privilege`. ISO-30 is the same check with an ADMIN-only breaker (one breaker per assertion). The down also leaves `USAGE ON SCHEMA app` alone when `nominara_owner` owns the schema (membership of the owner needs no clause: a REVOKE from `nominara_owner` leaves inherited rights untouched).
- **The function ACL is asserted directly** (ISO-27, MD-5: `aclexplode(proacl)` is exactly the function owner and `nominara_owner`, no
  PUBLIC grantee), not through a role-name filter. `TimeZone` and `DateStyle` are pinned on the functions, because the partition
  bounds are read back through `pg_get_expr`, whose text depends on both.
- **The definer-owner role holds no role** (ISO-28, the converse of ISO-24), and the migration strips any membership it finds on
  re-run (MD-10), because PG16 decides INHERIT per grant and the `NOINHERIT` attribute alone does not cover it.
- A vector-recall result below `VECTOR_RECALL_THRESHOLD` raises an alert only. The `REINDEX CONCURRENTLY` stays operator-run
  (`pnpm db:maintenance:run`); the nightly tick never rebuilds (owner decision 58(b)).
- `DATABASE_ROLES` does not list the role (the roles spec migrates 0001-0005 only); `DEFINER_OWNER_ROLES` does, and `ISO-24` /
  `db:drift-check` read it from there.
