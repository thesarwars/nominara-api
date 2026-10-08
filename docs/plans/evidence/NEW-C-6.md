# NEW-C-6 — Recovery plan: one authority task per seedable citation gap

Status: BLOCKED (cut by the story's own rule). No code written. Branch 7day/c-comp-3 at ef53037 plus this file.

## Why it is blocked

The story's last acceptance criterion: "BLOCKED if Track B has not landed a task-insert helper by day 5. Cut it, rather than writing a second task-insert path."

Checked on integration/7day f201f35 (merged into this branch):

- The only `INSERT INTO tasks` in `src` outside the demo seed is `TasksService.createTask` in `src/modules/tasks/tasks.service.ts`. It is the manual path: origin is hard-coded `'manual'`, the dedupe fingerprint is `sha256('manual:' + random uuid)` (it never collapses by design), the description is empty, and it takes only title, kind and goal. It cannot set `origin='auto'`, `source_displacement_id`, `affected_url`, `source_domain_id`, a deterministic fingerprint, or `rule_code`.
- No fingerprint function exists anywhere in `src` (grep for "fingerprint" finds nothing that builds a task fingerprint).
- No generator (STORY-063) has landed.

Building the task insert inside the displacement module would be a second task-insert path (the table is owned by the tasks service), which the story forbids. Generalising `createTask` means editing `src/modules/tasks/` and its contract, outside this story's Technical Notes, and it needs Track B's decision on the fingerprint formula and the auto-task fields.

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Contract first: response is Task[] reusing Track B's task schema | Not started. `contracts/tasks/task-response.schema.ts` exists and could be reused; the contract commit is held back so a route is not declared with no handler. |
| 2 | RED from STORY-057 scenarios 9, 10, 12 | Not started. No RED sha, no failing count. |
| 3 | Idempotency-Key required, task:create, @Audit | Not started. (Pattern is in place: `displacement.controller.ts` already uses `task:create`, `@ScopedByQuery`, `@Audit`.) |
| 4 | BLOCKED if no Track B helper; cut rather than second path | Applied: this item is cut. |

Gates: not run, since there is no change. Last green state is NEW-C-5's evidence.
Real-API evidence (NEW-A-17): none to collect.

## What is needed to unblock (decision for the owner)

Pick one:
1. Track B adds a shared task-insert method on `TasksService` (export it, take origin, rule_code, deterministic fingerprint, source_displacement_id, affected_url, source_domain_id, title, description, and return the Task), and states the fingerprint formula. NEW-C-6 then calls it from `DisplacementService`, and sets `displacement_events.task_id`.
2. The owner authorises widening `createTask` in this lane (touching `src/modules/tasks/`), and decides the authority task fingerprint (suggested: sha256 of `authority:{project_id}:{source_domain_id or lower(domain)}:{displacement prompt_id}`), title and description wording.

Then the work is about a day: the contract (`recoveryPlanResponseSchema = z.array(taskSchema)`), RED for scenarios 9, 10, 12 (one task per seedable gap using the same `source_domains.is_seedable` read as `recoveryTaskCount`; none for a non-seedable gap; repeat call returns the same tasks with no duplicates; concept tasks zero until STORY-058), then `POST /displacements/:id/recovery-plan` with `Idempotency-Key`, `task:create`, `@Audit`, and a 409 carrying the existing task ids for a plan that already exists.

Spans: OpenTelemetry deferred to week 2 (owner decision 3).

## Re-check (2026-10-08, days 5-6 run)

Re-checked integration/7day (f201f35), 7day/b-tasks-3 (e32ffe9) and 7day/b-ws-3: none contains a task-insert helper with origin, rule_code, deterministic fingerprint or source_displacement_id; `git grep -i fingerprint -- src` finds only the idempotency fingerprint. The blocking condition still holds, so the item stays cut. No code, no contract, no RED commit.

Re-check (resume run, 2026-10-08): integration/7day still f201f35, already merged here; 7day/b-tasks-3 and 7day/b-ws-3 still have no task-insert helper (only the schema columns). Blocking condition unchanged; item stays cut.
