# NEW-A-13 — scheduler sweep tick — STATUS: DONE (Option A, owner decision 2026-10-08)

Branch 7day/a-gemini-4, base integration/7day fee788e. Replaces the earlier BLOCKED evidence (the blocker was the advance-order conflict with the merged capture.plan handler; the owner chose Option A).
Migrations: none (owner connection, no new role; range 0120-0121 unused).

Commits: RED 54798f6 (stub + specs, unit 6 of 6 failed, integration 10 of 12 failed); fix ed2fbec.

## AC2 reworded (carried to the docs hub: docs/plans/docs-carry/NEW-A-13.md)

Original: "claimDueProjects ... advances next_run_at before enqueueing in the same transaction."
Now: the sweep claims due projects (FOR UPDATE SKIP LOCKED, ordered by next_run_at) and enqueues one signed capture.plan job per project, dedup key run:{project}:{next_run_at}, holding the claim transaction across the enqueue. The sweep never advances next_run_at; only the capture.plan handler does. Two concurrent ticks never enqueue the same project twice. soft_capped and suspended workspaces are skipped.
No handler change: the merged, audited NEW-A-10 handler is untouched.

## Acceptance criteria

| AC | Proof (file :: test) |
|----|----------------------|
| AC1 mechanism per O4: in-process runtime in the capture worker, hourly at :05 UTC | test/unit/capture-scheduler-sweep.spec.ts :: "AC4 nextSweepAfter ...", "AC4 the schedule is UTC whatever the process time zone", "AC1 start() arms the next :05 UTC, ticks there, and re-arms ...", "AC1 stop() cancels ... start() twice arms only one", "AC1 a tick that cannot reach the database is best-effort ..."; test/integration/worker-scheduler-sweep-wiring.spec.ts :: "AC1 WORKER_GROUP=capture starts the sweep", "AC1 WORKER_GROUP=%s never starts a scheduler sweep" (6 other groups) |
| AC2 claim, enqueue per project, dedup key, no advance, no double enqueue, skips | test/integration/capture-scheduler-sweep.spec.ts :: "AC2 enqueues one job per due project, longest-waiting first, keyed run:{project}:{next_run_at}", "AC2 skips soft_capped and suspended workspaces, paused and deleted projects, ... not yet due or never scheduled" (also asserts claimDueProject, the handler's claim, agrees on every project), "AC2 an empty tick ...", "AC2 the sweep never advances next_run_at or last_run_at", "AC2 two concurrent ticks never enqueue the same project twice (the claim is held across the enqueue)", "AC2 a failed enqueue is reported as partial ...", "AC2 end to end with the handler ..."; test/unit :: "AC2 the key is run:{project}:{next_run_at} ..." |
| AC3 every job signed for the project's own workspace; sweep reads only id, workspace id, cadence, next_run_at | capture-scheduler-sweep.spec.ts :: "AC3 every enqueued job is a real signed capture.plan job for the project's own workspace, and a repeated sweep adds no second job" (real QueueProducer over a Valkey container; HMAC verified with rotatingHmacJobVerifier; payload parsed by capturePlanJobSchema; two workspaces; a second sweep leaves 2 jobs), "AC3 the claim reads only project id, workspace id, cadence and next_run_at" (select list asserted), "AC3 a connection that cannot see across tenants fails closed with SchedulerBlindError and enqueues nothing" (nominara_app) |
| AC4 next_run_at = now() yields a scheduled run within one tick; cron stated in UTC | capture-scheduler-sweep.spec.ts :: "AC4 a project whose next_run_at is now() is enqueued by the next tick" (runtime.tick() on a real connection); unit :: the :05 UTC tests above. "Within one tick" means up to the next :05 UTC (hourly). The full local path (real worker, real Gemini) is collected in NEW-A-17. |
| AC5 dangerous-area-auditor review (cross-tenant read) | NOT RUN by this lane (an auditor is a separate role). Material for the auditor: the only cross-tenant read is claimDueProjectRefs (4 columns); guarded by the pg_roles check; the transaction holds row locks across a Valkey await by design (header of scheduler-sweep.ts). |

Observability: metrics nominara_capture_scheduler_sweeps_total{status=complete|partial|blind|connect_failed}, nominara_capture_scheduler_jobs_enqueued_total, nominara_capture_scheduler_enqueue_failures_total; log lines capture.scheduler.enqueued (workspace_id, project_id), capture.scheduler.enqueue_failed, capture.scheduler.sweep (counts). Verified by capture-scheduler-sweep.spec.ts :: "observability: ..." (no workspace name in any line). Spans: OpenTelemetry deferred to week 2 (R3); no span is claimed.

## RED

54798f6: stub module with signatures only (no behaviour) + the two specs.
- test/unit/capture-scheduler-sweep.spec.ts: exit 1, 6 failed of 6 (assertion failures on the stub: wrong times, connects never called).
- test/integration/capture-scheduler-sweep.spec.ts: exit 1, 10 failed / 2 passed of 12. The 2 that passed on the stub were "an empty tick" and "never advances" (vacuous on a stub); the latter is covered by mutation M2 below.

## Mutations on the fix (spec = capture-scheduler-sweep.spec.ts, each reverted)

| Mutation | Result |
|---|---|
| M1 commit and re-BEGIN before the enqueue loop (claim not held across the enqueue) | exit 1, "two concurrent ticks ..." fails |
| M2 the sweep advances next_run_at | exit 1, 3 failed: "never advances", "skips ...", "a failed enqueue ..." |
| M3 remove the blind-role check | exit 1, "a connection that cannot see across tenants ..." fails |
| M4 allow soft_capped in CAPTURABLE_WORKSPACE_STATUSES | exit 1, "skips soft_capped ..." fails |
Not mutation-tested: the worker wiring calling start() (the wiring spec proves presence, not that the timer is armed; the arming is covered at unit level by the runtime tests).

## Test-setup notes (no assertion weakened)
- The end-to-end test runs the handler AFTER the sweep commits, as production does (the job travels through the queue). Run inside the sweep's enqueue it deadlocked: the sweep holds the project row lock and the handler's FOR UPDATE claim waits on it. That is a test artifact, not a product defect.
- AC4's clock is anchored 1 ms after the next_run_at the database wrote (UPDATE ... SET next_run_at = now() RETURNING). The host clock and the colima VM drift by milliseconds, which made `next_run_at <= host now` flaky; the property under test (a project set to now() is enqueued by the next tick) is unchanged.

## Gates (tree ed2fbec plus this evidence)

| Command | Exit | Result |
|---|---|---|
| pnpm lint | 0 | |
| pnpm typecheck | 0 | |
| pnpm test:unit | 0 | 303 files passed, 1 skipped; 3703 tests passed, 1 skipped |
| vitest integration: capture-scheduler-sweep, worker-scheduler-sweep-wiring, worker-canary-wiring, worker-group-bootstrap | 0 | 4 files, 42 tests |
| vitest integration: capture-scheduler, capture-plan-handler (STORY-033 and NEW-A-10, which share scheduler.ts, refactored here) | 0 | passed in the 5-file run (63 passed, 1 failed); the 1 failure was worker-group-bootstrap (7 vs 6 worker connections), fixed afterwards. These two files were not re-run after that fix, which touched only src/worker.ts |
| pnpm test:isolation | 1 | 12 files passed, 1 failed (see NEW-A-7 evidence): only ISO-14, src/modules/reports/scheduled-reports.service.ts:234 (e-reports) |
| pnpm test:isolation:breakers | 0 | 24 of 24 |

## Design notes for the reviewer
- The worker-group-bootstrap spec counts worker connections; the sweep therefore enqueues through the group's one shared producer-side (reader) connection and opens none of its own. First attempt used a new worker connection and failed that spec (7 vs 6).
- A backlog larger than one batch (500) re-claims the same oldest rows each tick until the handler advances them; their jobs are deduplicated by the queue. A deduplicated add still counts as `enqueued` in the sweep result, so the result does not show it; a follow-up can compare the returned job's creation time if that matters.
- The bootstrap log line for the capture group still says capture.plan "needs a per-workspace sweep"; it is now stale text (src/lib/queue/schedule-registrar.ts, outside this story's files). Not changed.

# Checkpoint-3 fix pass (branch 7day/a-gemini-4, base integration/7day fee788e)

Two audit findings, fixed red-first. Migrations: none. RED 98b8bfb (unit 7 failed of 13; integration 5 failed: CP3-1d, CP3-2, CP3-3d by timeout/pending, CP3-4a, CP3-4b by missing `armed`/`enqueue`). Fix 9eb8692; a strengthening test commit follows it (connect bound proven alone). The RED commit does not typecheck on its own (it uses the new `limits` option); the fix commit does.

## Finding 1 (blocker): the sweep held row locks across an unbounded Valkey call

Three layers, all in src/lib/capture/scheduler-sweep.ts (src/worker.ts unchanged):
1. each enqueue raced against `enqueueTimeoutMs` (default 5 s); a timeout is a failed enqueue (`EnqueueTimeoutError`, partial); the claim transaction has a `transactionBudgetMs` (30 s) after which no further row is attempted and the unsent rows are counted failed.
2. Postgres bounds the transaction: `set_config('lock_timeout', ...)` and `set_config('idle_in_transaction_session_timeout', ...)` with is_local => true, right after BEGIN (15 s idle, 5 s lock by default). No session-level SET.
3. `tick()` is raced against `tickTimeoutMs` (60 s) and `connect` against `connectTimeoutMs` (10 s); on expiry the connection is ended (locks dropped), a late-opening connection is closed, and arm() runs regardless.
Defaults are mine (the finding gave no numbers): enqueue 5 s < idle 15 s < budget 30 s < tick 60 s, so the layers nest. Tell me if the owner wants others.

| Required | Proof (file :: test) |
|---|---|
| 1. bound each enqueue, timeout = failed enqueue | unit :: "CP3-1a ... abandoned after enqueueTimeoutMs and counted as a failed enqueue (partial)", "CP3-1c ... budgeted" |
| 2. Postgres-side bound, transaction-scoped | unit :: "CP3-1b ... set lock_timeout and idle_in_transaction_session_timeout transaction-locally, after BEGIN and before the claim" (params, is_local true, no bare SET); integration :: "CP3-2 Postgres bounds the transaction itself" (server ends the session; second connection's FOR UPDATE NOWAIT succeeds with the client never letting go) |
| 3. bound the tick so arm() always runs | unit :: "CP3-3a connect that never answers ... next :05 tick still fires" (tick bound out of play, connect bound alone), "CP3-3b stalled tick abandoned, connection ended, next :05 tick still fires", "CP3-3c tick() resolves null"; integration :: "CP3-3d tick whose enqueue never resolves ... locks released, tick() settles" |
| 4. never-resolving enqueue test: locks released within the bound AND next :05 tick fires | integration :: "CP3-1d" (real Postgres, NOWAIT succeeds) + unit CP3-3a/3b (fake timers, next :05 fires). The two halves live in different specs because fake timers cannot drive a real Postgres socket |
| observability | unit :: "CP3-obs": metric nominara_capture_scheduler_sweeps_total{status=timed_out}, nominara_capture_scheduler_enqueue_failures_total; log lines capture.scheduler.tick_timed_out, capture.scheduler.enqueue_failed (error EnqueueTimeoutError, ids only), capture.scheduler.budget_exhausted. Spans deferred (R3). |

Mutations (each reverted): no enqueue timeout -> CP3-1a, 1c, obs fail; no tick race -> 3b, 3c, obs fail; no budget -> 1c fails; lock_timeout dropped -> 1b fails; idle timeout dropped ("0") -> integration CP3-2 fails; no connect timeout -> 3a fails (first attempt survived, because the tick bound covered it; the test now takes the tick bound out of play).
The tick bound also protects `connect()` having no `connectionTimeoutMillis` in src/db/client.ts (not touched; the runtime races it instead).

## Finding 2 (major): deleting `sweepRuntime.start()` left every test green

No change to src/worker.ts. Added to the runtime: `get armed()` (true between start() and stop()) and a public `enqueue` (the closure the runtime ticks with). test/integration/worker-scheduler-sweep-wiring.spec.ts:
- "CP3-4a the capture worker's sweep timer is ARMED": bootstraps the capture group, asserts `holder.runtime.armed`.
- "CP3-4b the PRODUCTION enqueue closure ...": calls `holder.runtime.enqueue(job)` on the bootstrapped worker against the Valkey fixture and reads the real `capture.plan` queue (production prefix): exactly one job, signature present, payload parses with capturePlanJobSchema (trigger scheduled, the right workspace and project), a repeated key adds no job, a new next_run_at adds one. Jobs are counted across all states because the capture group's own worker consumes capture.plan in-process.
Mutations on src/worker.ts (each reverted): delete `sweepRuntime.start();` -> CP3-4a fails; per-call random idempotency key -> CP3-4b fails; wrong queue name ("capture.parse") -> CP3-4b fails. Used the allowed alternative to the fake-clock bootstrap (the closure is read through the holder, not re-written in the test); a full fake-clock bootstrap would need a real Postgres in the worker, which this lane left to NEW-A-17.

## Gates (tree after the last commit)

| Command | Exit | Result |
|---|---|---|
| pnpm lint | 0 | |
| pnpm typecheck | 0 | |
| pnpm test:unit | 0 | 303 files passed, 1 skipped; 3710 tests passed, 1 skipped |
| vitest integration: capture-scheduler-sweep, worker-scheduler-sweep-wiring, worker-canary-wiring, worker-group-bootstrap, capture-scheduler, capture-plan-handler | 0 | 6 files, 76 tests |
| pnpm test:isolation | not run | no tenant table or RLS file touched |
