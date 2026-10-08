# STORY-064-D evidence (checkpoint-2 close-out, lane 7day/b-tasks-3)

Base: integration/7day f201f35. Worktree api-wt-b1. Observability: metrics and redacted log line only; OpenTelemetry spans are deferred to week 2 (owner decision 2026-10-08), so a missing span is not a failed criterion this week.

## Acceptance criteria

| # | Criterion | Proof | RED |
|---|---|---|---|
| 1 | `complete-task-response.schema.ts` in its own commit; `verification` nullable, null until STORY-067 | commit a0b23c2 touches only contracts/ ; contracts/tasks/task-contract.test.ts | a0b23c2 precedes RED c006bec |
| 2 | Completing a done or dismissed task is 409 with `current_state` | test/integration/task-complete.spec.ts "[STORY-064-D] completing a done task is a 409 with current_state..." and "...a dismissed task is a 409 with current_state=dismissed..." | c006bec (integration only) |
| 3 | One transaction: milestone + 'completed' event + refreshProjectTaskCounts; baseline_metrics untouched | task-complete.spec.ts "completing writes status, completed_at/by, a task_completed milestone...", "baseline_metrics (captured at creation) is untouched...", "a rolled-back completion leaves no milestone, no event, and publishes NOTHING"; "two concurrent completions: exactly one wins" | c006bec |
| 4 | task.moved published after commit to the ws room only; another workspace's socket receives nothing | task-complete.spec.ts "a successful completion publishes task.moved to the caller's workspace room only..."; test/integration/task-realtime-rooms.spec.ts "task.created and task.moved (complete) reach the owning workspace's socket, and another workspace's socket receives nothing" (real Valkey + socket.io) | c006bec |
| 5 | PATCH and create also publish after commit | task-complete.spec.ts "PATCH publishes task.moved on a status change (and only then); create publishes task.created; neither before commit" | c006bec |
| 6 | `@Idempotent`; RBAC `task:move` (the CP2 QA failure) | src/modules/tasks/tasks.spec.ts, describe "STORY-064-D · complete route wiring": "AC6 · complete requires task:move", "AC6 · complete is @Idempotent", "AC6 · complete enforces project scope in the service (ScopedByQuery) and is audited as task.completed", "AC1 · complete publishes the completeTask operation..." | e7e7590, see below |

### RED for criterion 6 (e7e7590)
The decorators were already correct, so the new tests pass on the unmutated code (19/19 in tasks.spec.ts). The RED is the QA mutation, reproduced on this tree: remove `@Idempotent()` from `TasksController.complete` and change its `@RequirePermission("task:move")` to `"task:read"`:
`pnpm vitest run src/modules/tasks/tasks.spec.ts` -> exit 1, "2 failed | 17 passed (19)": "complete requires task:move" and "complete is @Idempotent" fail. The mutation was reverted (`git checkout`), nothing committed.

## Audit changes (CP2 b-tasks audit: approve_with_changes)

| Finding | State | Proof |
|---|---|---|
| Soft-delete guards untested; tasks of a soft-deleted project could be completed | CLOSED (fixed earlier in b38a984, RED b42bef7) | test/integration/task-complete.spec.ts, describe "soft-deleted task / project guards" (7 tests, names carry STORY-064-C/D). RED re-run now: service file reverted to b38a984^ -> `vitest ... task-complete.spec.ts` exit 1, "3 failed | 14 passed (17)" (complete, comment and timeline on a task of a soft-deleted project). With the fix: all pass. |
| `task.created` (and `task.moved`) carry the task title to every member of the workspace, including scoped members who cannot read that project | OPEN, NOT BUILT: needs an owner decision | See below. |

### Open item: scoped delivery of task events
The gateway (src/gateway/realtime.gateway.ts, fan-out loop) delivers every event to the workspace room `ws:{id}` and documents the limit itself: there is no `toProject` publisher, so a project-scoped event reaches every member regardless of `workspace_members.project_scope`. Story AC4 says "to the ws room only", and api-specification.md section 11 fixes the `task.created` payload with `title`. Closing the leak means one of:
1. a project-aware delivery path (publisher `toProject` + gateway filtering by joined `proj:{id}` rooms): touches src/lib/cache/realtime-publisher.ts and src/gateway/, outside this story's files, and changes AC4;
2. dropping or nulling `title` from `task.created` / `task.moved`: changes the section 11 payload and the events catalog contract;
3. accept the limit for week 1 (the same limit already applies to aux.finding_created and displacement.detected).
Needed from the owner: pick 1, 2 or 3, and have it written into STORY-064-D and section 11. Not decided here (hard boundary: scope outside the story's files and a contract change).

## Gates (run in api-wt-b1 at e7e7590)
- `pnpm lint` exit 0
- `pnpm typecheck` exit 0
- `pnpm test:unit` exit 0 (277 files passed, 1 skipped; 3317 tests passed, 1 skipped)
- `pnpm vitest run --config vitest.integration.config.ts test/integration/task-complete.spec.ts task-create.spec.ts task-realtime-rooms.spec.ts task-update.spec.ts` exit 0 (4 files, 41 tests; colima socket via DOCKER_HOST). Disk free 17 GiB before running.
- test:isolation: not run (no tenant table or migration touched; known fixture crash at this tip is the d-admin lane's). Tenant isolation for these paths is covered by task-realtime-rooms.spec.ts (foreign workspace receives nothing) and the 404 for a foreign-tenant task in task-complete.spec.ts.
- Evidence needing a running real API (HTTP-level Idempotency-Key replay on /complete, real scoped socket): collected in NEW-A-17. The replay behaviour comes from the global IdempotencyInterceptor (test/unit/idempotency-http.spec.ts); there is no complete-specific replay test this week.

## Notes
- No migration, no schema change, no new dependency.
- STORY-064-C passed QA at checkpoint 2; its notes (manual-task dedupe fingerprint and empty-description defaults still need an owner decision) are unchanged.
