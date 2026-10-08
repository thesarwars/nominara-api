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

## Audit round 4: scoped task events (still OPEN, awaiting owner)
Not closed: recording a decision I do not have would be inventing one. The owner must pick option 1 (toProject delivery), 2 (drop title from task.created/task.moved) or 3 (accept for week 1); the pick must then be written into STORY-064-D AC4 and api-specification section 11 (`task.created` row). Code and contract are unchanged.

## Checkpoint-3 fix pass (lane 7day/b-tasks-4, base integration/7day fee788e): ids-only realtime events
Owner decision 2026-10-08: send only ids in `task.created` / `task.moved`; clients refetch. This CLOSES the "OPEN, awaiting owner" findings above (options 2 chosen, narrowed to ids).
- RED 0054f0e (tests only): `vitest run test/unit/realtime-event-catalog.spec.ts` exit 1, "1 failed | 39 passed" ("task.created is exactly {task_id, project_id}: a title is refused"); `vitest run --config vitest.integration.config.ts test/integration/task-complete.spec.ts test/integration/task-realtime-rooms.spec.ts` exit 1, "3 failed | 16 passed": "neither task.created nor task.moved carries the task title" (`expected ... not to contain 'Confidential-title-...'`), the PATCH/create payload test and the socket-room test (payload had 7 keys, expected 2).
- Fix c85c4dd: `taskCreatedEventSchema` is `{task_id, project_id}` (strict); `TasksService.createTask` publishes ids only; `contracts/openapi.generated.json` regenerated (`contracts:generate` then `contracts:check` exit 0).
- Checkpoint-3 audit (major): the owner never confirmed that statuses may stay, so `task.moved` is cut to `{task_id, project_id}` (strict); from_status, to_status and actor_id are removed. This supersedes the "unchanged" judgement call above. AC4 must be carried to the story in the docs repo as "task.created and task.moved payloads are ids only".
- RED bf9c0e9 (tests only): unit realtime-event-catalog.spec.ts exit 1, 1 failed | 39 passed; integration task-complete + task-realtime-rooms exit 1, 3 failed | 16 passed. Fix 666ea99: taskMovedEventSchema, the two publishMoved calls in tasks.service.ts, openapi regenerated (contracts:check exit 0; contracts:diff base to current: none).
- Tests: realtime-event-catalog.spec.ts "[STORY-064-D realtime ids-only] task.moved is exactly {task_id, project_id}..."; task-complete.spec.ts "a successful completion publishes task.moved ... catalogued payload" and "PATCH publishes task.moved on a status change"; task-realtime-rooms.spec.ts "task.created and task.moved (complete) reach the owning workspace's socket"; realtime-fanout-coalescing.spec.ts payload now ids only (typed, cast removed).
- Gates: lint 0; typecheck 0; test:unit 0 (302 files passed, 1 skipped; 3700 passed, 1 skipped); integration task-complete, task-realtime-rooms, realtime-fanout-coalescing, task-goals, task-update, task-create, project-tasks exit 0, 7 files, 83 tests. test:isolation not run: no tenant table, policy or migration touched.
- Contract note: removing fields from an event payload is a "major" under `contracts:diff` against the previous-minor baseline (the baseline already diffed "major" from earlier recorded breaks; it carries no event schemas, so no operation-level `assert` can be written). Recorded here and approved by the decision; no breaking-changes.json entry because that file asserts REST operations only.
- Docs: api-specification.md §11 `task.created` row must become `{task_id, project_id}`. The snapshot has no .git and docs/references/api-specification.md must stay byte-identical to it, so the edit is carried in docs/plans/docs-carry/api-specification-section-11.md (not applied).
- Acceptance mapping: AC4 "task.moved published after commit to the ws room only" and AC5 are unchanged and green (task-complete.spec.ts, task-realtime-rooms.spec.ts, which now expects `[{task_id, project_id}]` for created).
- Tests: test/unit/realtime-event-catalog.spec.ts describe "STORY-064-D · task.created and task.moved carry ids only" (2 tests); test/integration/task-complete.spec.ts "[STORY-064-D realtime ids-only] ...".
- Observability: unchanged (metric and redacted log line already ids-only); OpenTelemetry spans deferred to week 2, a missing span is not a failure.
- Gates: lint 0; typecheck 0; `pnpm test:unit` 0 (302 files passed, 1 skipped; 3700 tests passed, 1 skipped); integration (task-goals, task-complete, task-realtime-rooms, realtime-fanout-coalescing, task-create, task-update, project-tasks, portal-tasks-http) exit 0, 8 files, 97 tests. test:isolation not run: no tenant table, policy or migration touched.
