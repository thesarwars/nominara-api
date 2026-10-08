# NEW-A-13 — scheduler sweep tick — STATUS: BLOCKED, nothing built

No code, contract or test was written for this story. Two things stop it; both need a decision or a change in the environment, not more engineering.

## Blocker 1 — the acceptance criterion contradicts the merged NEW-A-10 handler (needs an owner/spec decision)

AC2 (and tracking-engine.md section 5, "Scheduler query") says the sweep advances `next_run_at` BEFORE enqueueing, in the same transaction.
The merged `capture.plan` handler (src/lib/queue/handlers/capture-plan.handler.ts, NEW-A-10, audited, QA-passed) re-derives dueness itself:
`claimDueProject` requires `next_run_at <= now`, and `planScheduledRun` is what advances the schedule. Its header makes that the idempotency mechanism
("the job carries a project, not a decision").

If the sweep advances first, every job it enqueues finds the project not due and plans nothing. So the two cannot both hold as written.

Options (the question the owner must answer):
- A (recommended): the sweep does NOT advance. It claims with `claimDueProjects` (FOR UPDATE SKIP LOCKED, ordered by next_run_at) and enqueues one signed
  `capture.plan` job per project with the dedup key `run:{project}:{next_run_at}` (the topology's `run:{project}:{window}` pattern), the claim transaction held
  across the enqueue. The handler stays the only thing that advances. "Two concurrent ticks never enqueue the same project twice" then rests on the row lock
  plus the dedup key, not on the advance. No handler change. Needs AC2 reworded in the story and in the reference.
- B: change the handler to accept a job for a project the sweep already advanced (needs the original due time in the payload). Reopens an audited dangerous-area
  handler and lets a forged or replayed job choose a due time. Not recommended.

Also unanswered for AC1 (O4): mechanism and role. Intended, unless told otherwise: an in-process runtime in the capture worker (CanaryRuntime pattern),
the owner connection (`DATABASE_URL`, as credit.reconcile / identity.sweep_unverified use), so no migration and no new role. Tick = hourly at :05 UTC
(references/system-architecture.md section 4, ci-cd-and-environments.md "hourly at :05"). "Within one tick" locally therefore means up to the next :05 UTC.

## Blocker 2 — disk gate

`df -h /System/Volumes/Data` shows 7.4 GiB free (7.1 GiB earlier), under the 8 GiB floor for testcontainers specs. Every behaviour this story is about
(SKIP LOCKED under two concurrent ticks, soft_capped/suspended skipped, signed jobs per workspace) needs a real Postgres, so the RED tests cannot be run
and confirmed failing for the stated reason. Not worked around.

## Per-criterion status

| AC | Status |
|---|---|
| 1 mechanism per O4 | Not built. Blocked on O4 confirmation above. |
| 2 RED tests (claim, advance-before-enqueue, no double enqueue, skip soft_capped/suspended) | Not written. Blocked on Blocker 1 wording and Blocker 2. Note: `claimDueProjects` already skips non-trialing/active workspaces (CAPTURABLE_WORKSPACE_STATUSES) and is covered by test/integration/capture-scheduler.spec.ts (STORY-033). |
| 3 jobs signed per project workspace; sweep reads only ids, cadence, next_run_at | Not built. |
| 4 local next_run_at=now() yields a Gemini run in one tick; cron stated in UTC | Not built. Needs a running real API/worker; collected in NEW-A-17. |
| 5 dangerous-area-auditor review | Not run; nothing to review. |

RED commit: none. Gates: none run for this story (no change). Metrics/log/span: none; spans deferred to week 2 by decision.
