<!-- Carry to the docs repo (Nominara-Dev-Docs-main has no .git): references/tracking-engine.md section 5 "Scheduler query" (the sentence after the SQL block, line 237), references/system-architecture.md section 6.1 (lines 195-196), and the NEW-A-13 acceptance criterion 2. Owner decision 2026-10-08, "Option A". -->

## tracking-engine.md, section 5, "Scheduler query" — replace the sentence "`next_run_at` is advanced **before** enqueueing, inside the same transaction, so a scheduler crash cannot double-schedule." with:

The sweep **does not advance** `next_run_at`. It claims the rows above (the claim transaction is held across the enqueue) and enqueues one signed `capture.plan` job per project with the dedup key `run:{project}:{next_run_at}`. Only the `capture.plan` handler advances `next_run_at`, inside the job's tenant context, in the same transaction as the run row. A crash cannot double-schedule: the row lock stops a concurrent tick, and until the handler advances the project the next tick derives the same dedup key. The sweep selects only `p.id, p.workspace_id, p.cadence, p.next_run_at`.

## system-architecture.md, section 6.1 — replace lines 195-196 with:

```
 └─ SchedulerService (in-process in the capture worker, hourly at :05 UTC):
      SELECT projects WHERE next_run_at <= now() … FOR UPDATE SKIP LOCKED
      └─ enqueue one signed capture.plan job per project, dedup key run:{project}:{next_run_at}
           └─ capture.plan handler advances next_run_at (only it does)
```

## NEW-A-13 acceptance criterion 2 — reworded

"RED tests: `claimDueProjects` (FOR UPDATE SKIP LOCKED, ordered by next_run_at) claims the due projects and the sweep enqueues one signed `capture.plan` job per project with the dedup key `run:{project}:{next_run_at}`, holding the claim transaction across the enqueue. The sweep never advances `next_run_at`; only the `capture.plan` handler does. Two concurrent ticks never enqueue the same project twice. soft_capped and suspended workspaces are skipped."
