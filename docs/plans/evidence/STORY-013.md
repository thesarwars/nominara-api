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
| 14 | `scanForOrphans` (per partition) | metric `nominara_maintenance_orphan_fact_rows` (0 is observed), error log with table/partition/count, alert email, job FAILS with `UnrecoverableError` (one page per night) |
| 16 | new `findUnresolvedPurgeFailures` (`src/db/purge-check.ts`) | metric `nominara_retention_purge_failures_unresolved`; any unresolved failure alerts; past the 7-day grace the job FAILS (the runtime hook of "blocks the release train"). `reason` is never logged or mailed. |
| 6 | `computeRecallAtK` over `HNSW_INDEXED_TABLES` | metric `nominara_maintenance_vector_recall_ratio`; below 0.98 an error log + alert email + finding counter; a table with too few rows is a counted skip (null is not 0). NOT a failed job. |

A check that cannot run fails the job with an ordinary error after the others have reported; an errored scan never reads as clean.

AC3: `maintenance-partition.handler.ts` now also observes `nominara_partition_default_rows` per fact table every run (0 included) and
sends an alert email per table with stranded rows. It still does not fail the job (retrying cannot move rows).

Existing metrics/log names were left as they were (`partition_default_rows_detected`, the warn line), so no existing assertion changed.
Spans: `maintenance.integrity` with outcome and finding-count attributes; not asserted, because no in-memory span exporter exists in the repo.

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
