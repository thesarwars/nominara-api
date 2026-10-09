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

## Checkpoint-4 fix pass (second-engineer review, branch 7day/a-gemini-5, base 74e4b2f)

Finding 1 (method/gates) is context only: the reviewer's mutants A, A3, B, C, D, E, F are all caught by the existing specs; no action.

| Finding | Criterion -> test | RED sha | Fix sha |
|---|---|---|---|
| 5 `manual` cadence claimable, never advanced | capture-scheduler-sweep.spec.ts :: "NEW-A-13 AC2 · checkpoint-4 · a manual-cadence project with a past next_run_at is neither claimed by the sweep nor by the handler's claim"; capture-plan-handler.spec.ts :: "NEW-A-10 · checkpoint-4 · a manual-cadence project ... is not planned" | f183a18 (2 failed) | d53366b (`AND p.cadence <> 'manual'` in DUE_PROJECTS_WHERE and claimDueProject) |
| 4 crash between COMMIT and dispatch leaves a run `queued` with fair-use reserved | test/integration/capture-stale-run-reaper.spec.ts :: CP4-4a (failed + stale_queued + release of planned-skipped), 4b (fresh / just-inside-bound / running / manual untouched), 4c (idempotent), 4d (two tenants, own counters), 4e (never below zero), 4f (SchedulerSweepRuntime.tick reaps), 4g (metric nominara_capture_stale_runs_reaped_total + log line with workspace_id and run_id, no workspace name) | 403c7e5 (6 failed, 1 vacuous pass on the stub) | 84ba61e |
| 2, 3 | see NEW-A-10.md | | |

Finding 4 design: src/lib/capture/stale-run-reaper.ts, called by the sweep runtime after the claim transaction commits (best-effort, never fails the tick). It fails a `scheduled` run still `queued` after STALE_QUEUED_RUN_BOUND_MS = 6 h, and releases planned_cells - skipped_cells (the figure planRun reserved) inside withTenantContext per run. The bound is mine: the longest cell jitter is 1 h (CADENCE_JITTER_MAX_MS), so 6 h is well past a healthy first delivery; the owner may change it. Manual runs are deliberately excluded (they debit credits; a refund path is not decided). The billing period is resolved at reap time; a run lost across a period roll releases against the wrong row, floored at zero (accepted edge). No schema change. No span (R3).
Mutations on the reaper (each reverted): dropping the `trigger = 'scheduled'` predicate fails 4b; removing the release fails 4a, 4c, 4d, 4e, 4f.

### Finding 6 — NOT FIXED here: the pipeline is inert in production (needs an owning story / decision)
Nothing in src sets projects.next_run_at (projects.service inserts NULL and status 'initializing'; no path moves a project to 'active' or seeds next_run_at), so the sweep ticks with claimed=0 and reports `complete`. NEW-A-13 AC4 is proven only by setting next_run_at in SQL. Until a story seeds next_run_at on activation/confirmation, scheduled capture does not start for any real project; this is stated here as the inert state of NEW-A-13 and must be repeated in NEW-A-17 evidence. DECISION NEEDED from the owner: which event activates a project and seeds next_run_at (e.g. onboarding confirmation, first prompt set approved), and with what first-run offset. Touching projects.service is outside this item's files and the activation semantics are unspecified, so no code was written.

### Gates (tree 84ba61e)
| Command | Exit | Result |
|---|---|---|
| pnpm lint | 0 | |
| pnpm typecheck | 0 | |
| pnpm test:unit | 0 | 306 files passed, 1 skipped; 3755 tests passed, 1 skipped |
| vitest integration: capture-scheduler-sweep, worker-scheduler-sweep-wiring, capture-plan-handler, capture-scheduler, capture-stale-run-reaper, capture-execute-handler, capture-execute-rollup, worker-group-bootstrap | 0 | 8 files, 92 tests |
| pnpm test:isolation | 0 | 13 files, 53 tests |
| pnpm test:isolation:breakers | 0 | 24 of 24 |

## Checkpoint-5 fix pass (lane a-gemini, branch 7day/a-gemini-6, base 71e13e9)

Owner decision 2026-10-09 #2: a project created with a non-manual cadence gets next_run_at = the next cadence slot; manual is never claimable.

| Item | Test | RED | Fix |
|---|---|---|---|
| Finding 6 (nothing seeds next_run_at) | test/integration/project-create-next-run.spec.ts: "a project created with the default (non-manual) cadence gets next_run_at = the next cadence slot"; "the seeded project is claimable once active and its slot has passed, and not before" (real ProjectsService.create against migrations, then claimDueProject) | 2 failed (next_run_at null) | ProjectsService.create inserts cadence (DEFAULT_PROJECT_CADENCE = 'weekly', the column default) and next_run_at = nextRunAfter(cadence, now) |
| manual claimable | already fixed at d53366b (`p.cadence <> 'manual'` in DUE_PROJECTS_WHERE and claimDueProject), tests in capture-scheduler-sweep.spec.ts and capture-plan-handler.spec.ts, in the base | n/a | n/a |
| `status = 'queued'` guard in failUndispatchedRun untested | capture-plan-handler.spec.ts "a dispatch that rejects after a cell has started leaves the run and its fair-use reservation alone" | n/a (already in base) | Mutation re-run this pass: removing the guard fails exactly that test (1 failed, 17 passed); reverted |
| ambiguous dispatch failure vs running cells | base behaviour: the run is failed and capture.execute skips cells of a failed run (test "cells that WERE enqueued before an ambiguous dispatch failure do not call the vendor or write a capture"), so no cell runs against a released reservation | n/a | unchanged, see note |
| crash between COMMIT and dispatch | stale-run reaper, capture-stale-run-reaper.spec.ts 4a-4g, run by the sweep tick | n/a | in base (84ba61e) |

Notes:
- Cadence CHANGE: no code path changes projects.cadence today (no settings endpoint; STORY-043 AC2 says cadence is a settings change). The rule "on cadence change next_run_at = next slot" has nowhere to be applied yet; whichever story adds the change must call nextRunAfter in the same UPDATE. Not invented here.
- Seeding next_run_at does not make the sweep claim a project until it is status 'active' (the claim requires it); the create path leaves 'initializing' and the activation event is still not in any story. The claim test above sets status in SQL.
- Ambiguous dispatch: the instruction was "release only when no cell was enqueued, otherwise let the run finalise". The code cannot tell the two apart after a rejection, and fails the run + releases while making cells inert, which satisfies the stated hazard (no cell runs against a released reservation). Leaving the run queued instead would delay a genuine rejection to the 6 h reaper. Left as is; flagged for the lead.

Gates: lint 0, typecheck 0, test:unit 0 (309 files passed; a first run showed 3 failed files while integration containers were running, a rerun was clean twice), vitest integration: project-create-next-run, project-seeds, competitor-confirm-cap, capture-plan-handler, capture-scheduler-sweep, capture-stale-run-reaper: 6 files, 52 tests, all pass. test:isolation not run (no tenant table or policy touched).

## Checkpoint-5 fix pass 3 (lane a-gemini, branch 7day/a-gemini-6, base 71e13e9)

### Second-engineer finding 3 — reaper `status = 'queued'` mutant: FIXED (test gap)
Test: capture-stale-run-reaper.spec.ts :: "NEW-A-13 CP5-3 · a run that starts between the stale SELECT and the UPDATE stays running and its reservation is untouched". The client is wrapped in a Proxy; right after the stale SELECT returns, a second connection runs UPDATE capture_runs SET status='running'. Asserts reaped 0, status running, error_summary null, reserved_value unchanged.
No product change: the guard was already correct; the test was missing. The test commit is therefore green on the real code (it cannot be RED against correct code); its value was proved by mutation: removing `AND status = 'queued'` from the per-run UPDATE makes it fail (exit 1, "expected { reaped: 1 } to deeply equal { reaped: +0 }"), the other 7 tests still pass. Mutation reverted.

### Second-engineer finding 1 — activation event missing: STILL OPEN (blocked on an owner decision)
Checkpoint-5 finding 6 is NOT closed. ProjectsService.create now seeds next_run_at, but the INSERT writes status 'initializing', and DUE_PROJECTS_WHERE and claimDueProject require status = 'active'. No UPDATE projects in src sets status. The claim test only passes because it runs UPDATE projects SET status='active' in SQL. Inert state: the sweep still schedules nothing for any real project; repeat this in NEW-A-17 evidence.
NEEDED FROM THE OWNER: (a) the event that moves initializing -> active (e.g. onboarding confirmation, first prompt set approved); (b) when that happens with a long-past next_run_at: claim immediately, or reseed with a fresh nextRunAfter? The story that adds the event must test the chosen behaviour.

### Second-engineer finding 2 — starting cadence hard-coded 'weekly': STOPPED (blocked on an owner decision)
DEFAULT_PROJECT_CADENCE = 'weekly' regardless of plan; entitlements give scan.cadence weekly (starter), twice_weekly (growth), daily_priority (business), hourly_priority (enterprise). Only projects.cadence sets wake frequency, so a Growth project gets ~4 runs per cycle against 8 allowed. NEEDED FROM THE OWNER: does the starting cadence come from the workspace's scan.cadence entitlement (and the mapping daily_priority -> daily, hourly_priority -> ?, twice_weekly -> ?, given the cadence values the column CHECK allows), or does it stay weekly by policy? Once decided, the test is: create a project in a growth workspace and assert the exact interval of next_run_at (the current spec only checks cadence <> 'manual' and would pass with any cadence). Not written, because the expected value is the decision.

Gates: see the final report of this pass.

## Checkpoint-6 fix pass 4 (lane a-gemini, branch 7day/a-gemini-7, base 9b03547)

Owner decisions 2026-10-09 pm #1 and #2. Checkpoint-5 findings 1 (activation event) and 2 (starting cadence) are now FIXED.

### #1 Activation event
Event: `POST /v1/projects/{id}/prompts/activate` (PromptActivationService.activate), the prompt-set confirmation. After the activation UPDATE, if the project has at least one occupying prompt and is still `initializing`, one guarded UPDATE sets `status = 'active'` and `next_run_at = nextRunAfter(cadence, now)` (NULL for `manual`). The `status = 'initializing'` guard is repeated in the UPDATE, so a paused or already-active project is never touched and its next_run_at never moves; a replay is a no-op. A long-past next_run_at is always overwritten with a fresh slot, so there is no burst (asserted: `claimDueProject(now)` returns null).
Demo seed: `ensureDemoProjects` inserts status `active`, the starting cadence and `next_run_at = nextRunAfter(cadence, now)`.
Tests (test/integration/project-activation.spec.ts, 5; seed-demo.spec.ts, 2 via it.each growth/business): initializing -> active with next slot; 40-day-past next_run_at gets a fresh slot and is not claimable; manual stays NULL; paused untouched; already-active untouched.

### #2 Starting cadence mapping (src/lib/capture/starting-cadence.ts)
projects.cadence CHECK allows hourly, daily, twice_weekly, weekly, manual. twice_weekly IS allowed, so no rounding up was needed.
| scan.cadence | projects.cadence |
|---|---|
| weekly (starter) | weekly |
| twice_weekly (growth) | twice_weekly |
| daily_priority (business) | daily |
| hourly_priority (enterprise) | daily (capped until the hourly tier exists) |
| absent / null / unknown (e.g. free) | weekly (column default; an unknown entitlement buys no extra runs) |
Applied in ProjectsService.create and ensureDemoProjects. Tests in project-create-next-run.spec.ts use the real plan table through resolveEntitlements: growth asserts cadence twice_weekly and next_run_at = now + 30d/8 (3.75 days), plus starter, business, enterprise.

### RED -> GREEN
RED commit: 6 failed in project-activation + project-create-next-run (cadence 'weekly' != expected; status stayed initializing) and 2 failed in seed-demo. GREEN: project-activation, project-create-next-run, seed-demo: 3 files, 52 tests pass.

### Gates
lint 0, typecheck 0. test:unit: 1 failed file, test/unit/pagination-published-contract.spec.ts (the five bare lists, decision #3, another lane's RED test already in base; untouched by this change); 309 passed otherwise. test:isolation not run (no tenant table or policy touched). Cadence CHANGE path still has no code (unchanged note).
