# STORY-013 — nightly integrity tick (orphan scan, purge-failure check, vector-recall check) and the default-partition alert hook

Branch `story/013-maintenance-schedule`, base `origin/main` `4588f0b`. Migrations: none (read-only checks over existing tables).

D4 infrastructure is parked (decision 45): there is no alerting stack, no pager, no CI or release pipeline. This story builds
the code-side hook that infrastructure will call later and lists the remainder as infrastructure.

## What was built

New queue `maintenance.integrity` (rollup group, not tenant-scoped, advisory-locked), cron `10 3 * * *` UTC. The hour is a
choice, not a transcription (same caveat as every row in `schedule.ts`); the owner can move it. Handler
`src/lib/queue/handlers/maintenance-integrity.handler.ts` runs three READ-ONLY checks on the owner connection:

| AC | check | on a finding |
|---|---|---|
| 14 | `scanForOrphans` (per partition) | metric `nominara_maintenance_orphan_fact_rows_total` (0 is observed), error log with table/partition/count, alert email, job FAILS with `UnrecoverableError` (one page per night) |
| 16 | new `findUnresolvedPurgeFailures` (`src/db/purge-check.ts`) | metric `nominara_retention_purge_failures_unresolved_total`; any unresolved failure alerts; past the 7-day grace the job FAILS (the runtime hook of "blocks the release train"). `reason` is never logged or mailed. |
| 6 | `computeRecallAtK` over `HNSW_INDEXED_TABLES` | metric `nominara_maintenance_vector_recall_ratio`; below 0.98 an error log + alert email + finding counter; a table with too few rows is a counted skip (null is not 0). NOT a failed job. |

A check that cannot run fails the job with an ordinary error after the others have reported; an errored scan never reads as clean.

AC3: `maintenance-partition.handler.ts` now also observes `nominara_partition_default_rows_total` per fact table every run (0 included) and
sends an alert email per table with stranded rows. It still does not fail the job (retrying cannot move rows).

Existing metrics/log names were left as they were at the time (`partition_default_rows_detected`, the warn line), so no existing assertion changed. (Batch 19 later renamed the 28 grandfathered metric names to the convention, this one `nominara_partition_default_rows_detected_total`.)
Spans: `maintenance.integrity` with outcome and finding-count attributes; not asserted, because no in-memory span exporter exists in the repo.

## Review round 1 — what changed, and what is NOT working in production yet

* ⚠ AC3, AC6 and AC14 are NOT working production hooks under the documented role model. Every table they read is FORCE ROW LEVEL SECURITY
  (0006) and `nominara_owner` is NOSUPERUSER NOBYPASSRLS (security-and-tenancy.md §2), so on that role they would read zero rows and look clean.
  They now FAIL CLOSED: `assertCanSeeTenantRows` (rolsuper OR rolbypassrls) runs before any check; if it fails, no 0 and no recall skip is
  observed, `nominara_maintenance_integrity_check_errors_total{check="privilege"}` (or `default_partition_rows`) is counted, an error log is
  written and the job fails. Proven by an integration case on a NOSUPERUSER NOBYPASSRLS login role (mutation: guard removed -> red).
  They report truthfully only on a connection that can see tenant rows (a superuser or BYPASSRLS role, which is what the tests use).
  The lasting fix (a count-only SECURITY DEFINER function owned by a dedicated role, admitted by one role-targeted policy, the ADR-0002
  pattern) needs an ADR and an owner decision: raised, not chosen.
* A paging finding that coexists with a check that could not run is now `UnrecoverableError` naming both (one page, no retry ladder).
* The orphan scan also requires the parent's `workspace_id` to match (a cross-workspace mis-parent is an orphan).
* Partition DDL: `SET LOCAL lock_timeout = 5s` in `createPartition` (applies to the operator-run monthly maintenance too), and the orphan
  scan runs under a transaction-local `statement_timeout` of 300 s, so the 03:10 reader cannot stall writers behind the 03:20 DDL.
* The purge-failure alert no longer claims a release is blocked: `db:purge-check` is not wired into any pipeline.
* Alert mail is best-effort (90 s drain budget); the failed job in the dead-letter queue is the reliable signal.
* Evidence honesty: the original red-before-green was structural (registry/topology/schedule unit tests); the integration red was killed
  (013-red-int.log EXIT=143), so behavioural evidence for the first cut is 013-mutation1.log. Round 1 has its own red/green and mutation logs (013r1-*).

## Deliberately NOT done (decisions kept)

* The scheduled tick takes no ACCESS EXCLUSIVE-class lock and issues no DDL. `catchUpDefaultPartition` stays operator-run.
* The nightly vector check does NOT rebuild. `maintenance.partition`'s header keeps every resource-heavy or destructive step
  operator-invoked (`pnpm db:maintenance:run`). AC6 reads "a rebuild is triggered concurrently ... below the threshold": the
  rebuild code exists and is tested (T7), the nightly CHECK is now scheduled, and whether the nightly tick may run the REINDEX
  itself is an owner decision.
* The nightly retention SWEEP (expiry) is not scheduled here: it is destructive and outside the four ACs this lane was given.

## Infrastructure remainder (decision 45)

* A real alert route for default-partition rows, orphan rows and purge failures (pager or alert rules over the metrics above).
* `pnpm db:purge-check` wired into a release/deploy pipeline (`.github/workflows/gates.yml` or a release job).

## Doc changes needed (docs repo; do not edit the snapshot here)

* STORY-013 status check: AC3, AC6, AC14, AC16 code hooks closed; the infra remainders above stay open.
* `system-architecture.md` §4: add `maintenance.integrity` (daily, not in the original table) to the added-queues list, as for `audit.verify`.

## Review round 2 — owner decision 58 (migration 0160, ADR-0004)

* (a) The integrity checks now work under the documented `NOSUPERUSER NOBYPASSRLS` identity. Migration `0160` adds the NOLOGIN NOBYPASSRLS role
  `nominara_maintenance` and three count-only SECURITY DEFINER functions it owns: `app.maintenance_default_partition_rows()` (AC3),
  `app.maintenance_orphan_counts()` (AC14), `app.maintenance_recall_overlap(text, halfvec, int)` (AC6 inputs: a non-null count and the ANN/exact
  top-k overlap; no id or vector leaves it). One `FOR SELECT TO nominara_maintenance USING (true)` policy per table read (seven), column-level SELECT
  on key columns only, EXECUTE for `nominara_owner` only. `assertCanSeeTenantRows` is gone: the handlers assert the functions exist and are
  executable (`check="definer_function"`), and still fail closed with no 0 and no skip. `purge_failures` (global, no RLS) is still read directly.
* A column-level grant does not cover `tableoid`, so partitions are identified by their range bounds (`pg_class.relpartbound`) applied through the
  parent; the first cut with `tableoid` failed with a table-level permission error and is why (ADR-0004 consequences).
* `runPartitionRunwayMaintenance` now records a failed default-partition count instead of throwing before the runway is extended; the handler then
  fails the job after the runway, as before.
* (b) A recall below 0.98 raises the alert (metric + error log naming "operator-run") and does NOT rebuild; the code header and the log line say so, and a
  case fails if any REINDEX / CREATE INDEX / DROP INDEX is issued on any connection during the tick.
* (c) The 03:10 UTC cron is unchanged.
* Tests: `maintenance-count-definer.spec.ts` MD-1..MD-9 (real counts across three tenants as a NOSUPERUSER NOBYPASSRLS role with a blind-control read;
  counts-only output types and hostile `p_table`/`p_k`; column-only grants; runtime roles get 42501; owner/policy shape; ISO-07; missing default
  partition raises; 0160 rolls back and re-applies), `ISO-27` with a breaker (EXECUTE granted to PUBLIC), DEF-U1/U4/U5 in `rls-generate.spec.ts`.
  The retention-cascade "privilege proof" now asserts the worker is refused (42501) and reads 0 directly.
* Evidence: red `013r2-red-unit.log`, `013r2-red-int.log`; green `013r2-*.log`.

## Review round 3 — dangerous-area audit of round 2

* 0160 down revokes `USAGE ON SCHEMA app` from `nominara_owner` only if the up granted it (marker in a function comment); a blanket revoke would break `createPartition`'s `app.apply_tenant_rls()`. MD-9b holds it, `db:roundtrip-check` covers the granted case.
* ISO-27 and MD-5 assert the function ACL via `aclexplode(proacl)` (owner + `nominara_owner`, no PUBLIC); the ISO-27 breaker grants EXECUTE to a
  role without the `nominara_` prefix. New ISO-28 (a definer-owner role is a member of no role) with its own breaker; 0160 strips memberships on re-run (MD-10).
* The runway is shown to be extended when the count fails (partition-handler spec). MD-9 rolls back through 0160 by name, not "the last migration".
* The default-partition count runs under a call-side `SET LOCAL statement_timeout` (MD-12) and is shown to scan only `*_default` (MD-11); ADR-0004 corrected.
* `TimeZone` / `DateStyle` pinned on the functions; MD-2 filters `proallargtypes` by output mode; the retention-cascade "privilege proof" title matches its assertion.
* **Go-live item G-4:** the production maintenance login needs `nominara_owner` `WITH INHERIT TRUE` (PG16 per-grant INHERIT), or the code needs a `SET ROLE nominara_owner`.
  Until then the checks fail closed with `check="definer_function"`.

## Review round 4 — audit of round 3

* **Effective EXECUTE (ISO-29, MD-5).** ISO-27 / MD-5 keep the exact ACL; ISO-29 adds `has_function_privilege(role, fn, 'EXECUTE')` for each NAMED role
  (the four runtime roles, `nominara_share_lookup`, and `nominara_breakglass` when it is not BYPASSRLS; no prefix filter, so the G-4 maintenance login,
  a legitimate member of `nominara_owner`, is not flagged) and `pg_has_role(role, <ACL grantee>, 'SET')` (a NOINHERIT membership still reaches the rights via
  SET ROLE). Its breaker is `GRANT nominara_owner TO nominara_worker WITH INHERIT TRUE`; MD-5 runs the same grant (INHERIT and plain) inline.
* Output-mode filter is `t`, `o`, `b` (INOUT) in one shared helper (`maintenanceOutputTypes`) used by ISO-27 and MD-2; MD-2c shows INOUT / OUT / plain-return halfvec are seen.
* 0160 down also skips the USAGE revoke when `nominara_owner` owns schema `app` (MD-9c). Round 5 dropped the "member of its owner" clause and MD-9d: a REVOKE from `nominara_owner` cannot strip inherited rights, so MD-9d was green against the old down and proved nothing.
* `rollbackThrough0160` stops, without rolling back, when the newest applied migration is ordered before 0160.
* `detectDefaultPartitionRows` refuses to run inside an existing transaction (detected by the SQLSTATE 25001 warning from BEGIN; MD-13) and rejects a timeout < 1 or non-finite (MD-14).
* drift-check: the converse membership check (a definer owner must be a member of no role; DEF-D3). MD-11 asserts a non-default monthly partition exists.
* Red: `013r4-red-int.log`, `013r4-red-int-inout.log`, `013r4-red-migr.log`, `013r4-red-iso.log`; MD-5 and MD-10 against the round-2 tree (680b30dc):
  `013r4-red-r2tree-MD-5.log` (fails: TimeZone pin absent), `013r4-red-r2tree-MD-10.log` (fails: membership not stripped).

## Review round 5 — audit of round 4

* **Any membership counts (ISO-29, ISO-30, MD-5).** For each refused role r the check takes r plus every role Y with `pg_has_role(r, Y, 'MEMBER')` and fails when
  `has_function_privilege(Y, fn, 'EXECUTE')`. Replaces the `SET`-only second route. MD-5's inline loop now runs INHERIT, plain, a chain through an intermediate role
  (`INHERIT TRUE, SET FALSE`) and an ADMIN-only grant; the last two were missed by round 4 (`013r5-red-md5.log`). ISO-30 is the ADMIN-only breaker (`013r5-red-iso30.log`).
  The G-4 login (`maint_prod_like`) still passes.
* `detectDefaultPartitionRows`: the in-transaction guard is `SAVEPOINT dpr_probe` before `BEGIN` (25P01 outside a transaction = proceed; success = `RELEASE` and throw), independent of
  notices; MD-13b runs it with `client_min_messages = error` (`013r5-red-md13b.log`).
* MD-9d and the "member of its owner" clause of the 0160 down are dropped. MD-9c's restore re-grants USAGE to the original owner.
* MD-11's precondition filters on `relispartition`; MD-11b shows a plain table named like a partition is not counted (`013r5-red-md11b.log`).

### Doc changes needed (docs repo; not edited here)

* security-and-tenancy.md section 2: add `nominara_maintenance` (NOLOGIN, NOBYPASSRLS, definer-owner) next to `nominara_share_lookup`; section 3: seven
  role-targeted SELECT policies; ADR-0004 to the ADR index.
* data-model.md section 8 step 4: the nightly check ALERTS only; the rebuild is operator-run (decision 58b).
* STORY-013 Technical notes: new files (migration 0160, ADR-0004, `maintenance-count-definer.spec.ts`, ISO-27) and `src/db/conventions.ts`, `src/db/rls/generate.ts`.
