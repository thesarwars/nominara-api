# NEW-C-6 - Recovery plan: one authority task per seedable citation gap (STORY-057 AC6/7/8/9; FR-CO-04b)

Status: DONE (backend). Branch 7day/c-comp-4 from integration/7day fee788e. The earlier "BLOCKED / cut" status is superseded by owner decision 2026-10-08: option 1 (TasksService exports a shared task-insert
method), fingerprint `sha256('authority:{project_id}:{domain}')`.

Commits: contract `785d6ee` - RED `a86c10a` - fix `10e5787`.
RED: `vitest run src/modules/displacement src/lib/analytics/displacement-recovery.spec.ts` -> **4 failed / 22 passed, exit 1** (`recoveryPlan` not a function on the controller; `authorityTaskFingerprint` not exported; the per-domain count);
`vitest run --config vitest.integration.config.ts test/integration/displacement-recovery-plan.spec.ts` -> **11 failed / 1 passed, exit 1** (the observability test was added after the fix; the integration spec is now 13 tests, all passing, exit 0) (`service.recoveryPlan` is not a function; the 1 pass is the empty-table setup case).

## What was built
- `TasksService.createGeneratedTask(input)` (exported via TasksModule): the shared task-insert method. Inputs: projectId, kind, origin, ruleCode, fingerprint, title, description, sourceDisplacementId, sourceDomainId, affectedUrl. Returns `{task, created}`.
  Idempotent by fingerprint (open = not done, not deleted, the same predicate as `ux_tasks_dedupe`): an existing task is returned and nothing is written, no reference is consumed. A `pg_advisory_xact_lock` on project+fingerprint serialises concurrent callers.
  `createTask` (manual) now goes through the same private `insertTask`, so there is still ONE `INSERT INTO tasks` in src outside the demo seed. Manual behaviour is unchanged (task-create integration spec green).
- `DisplacementService.recoveryPlan(id)` + `POST /v1/displacements/{id}/recovery-plan` (201, `@Idempotent()`, `task:create`, `@ScopedByQuery()`, `@Audit displacement.recovery_planned`). Sets `displacement_events.task_id` to the plan's first task, once.
- `authorityTargets()` / `authorityTaskFingerprint()` in `src/lib/analytics/displacement-recovery.ts`; `recoveryTaskCount` uses `authorityTargets`, so the feed count and the plan cannot disagree.
- Contract `contracts/analytics/recovery-plan-response.schema.ts`: `z.array(taskSchema)` (Track B's schema, reused). openapi regenerated; `contracts:diff` = **minor** (one new operation), `contracts:check` exit 0.

## Acceptance criteria -> tests
1. Contract first, Task[] reusing Track B's schema: own commit `785d6ee`; `src/modules/displacement/displacement.spec.ts` > "NEW-C-6 - route wiring and contract" > "AC1 - the response is an array of the task schema ...".
2. RED from STORY-057 scenarios 9, 10, 12 (`test/integration/displacement-recovery-plan.spec.ts`):
   - #9 "STORY-057 #9 / NEW-C-6 AC2 - one authority task per seedable citation gap, linked to the displacement, fingerprint per the owner formula"
   - #10 "STORY-057 #10 / NEW-C-6 AC2 - a non-seedable or unknown domain gets no task, and the gap stays visible in the feed"
   - #12 "STORY-057 #12 / NEW-C-6 AC2 - a repeat call creates no duplicate task and burns no reference; it returns the same tasks", "STORY-057 #12 - a second displacement on the same project and domain reuses the open task rather than adding another"
   - concept tasks zero: "STORY-057 / NEW-C-6 AC2 - concept tasks are zero until STORY-058 ..."
   - widened: done task frees the fingerprint; two URLs on one domain = one task and equals `recovery_task_count`; empty gaps = empty plan; other workspace's seedable domain ignored; concurrent plans (one task, one reference); atomic rollback; fingerprint unit tests in `src/lib/analytics/displacement-recovery.spec.ts` ("NEW-C-6 - authorityTaskFingerprint").
3. Idempotency-Key required, `task:create`, `@Audit`: "NEW-C-6 - route wiring and contract" > "AC3 - the recovery plan needs task:create, requires Idempotency-Key, is scoped by the displacement and audited". Tenancy: "NEW-C-6 AC3 - under nominara_app, another workspace's displacement id is 404 and nothing is written; a scoped member outside the project is 403".
4. The cut rule: no longer applies; Track B's helper now exists, and it is the only task-insert path (no second path written).

## Decisions I took that the owner can overrule (none was in the story)
- A repeat call (or a second displacement on the same domain) returns the EXISTING open tasks with 201 and creates nothing, rather than a 409. Reason: the story says "a repeat call creates no duplicates, by dedupe fingerprint" and the response is Task[]; a 409 cannot carry task ids because the `conflict` error-details schema is strict and has no such member (a contract change nobody asked for). The client can tell new from existing by `created_at`. The frontend note "a 409 for an existing plan becomes a link" then needs no 409.
- Fingerprint per domain means two URLs on one domain are one task (the task's `affected_url` is the first URL in gap order); `recovery_task_count` now counts distinct seedable domains.
- Task `rule_code` is NULL (no `task_generation_rules` row exists for the plan; migration range says none), `impact_score` and `priority` are the column defaults (the scale of `displacement_events.impact_score` versus `tasks.impact_score` 0..100 is not defined in the reference). Title: "Earn a citation on {domain}".
- A dismissed displacement can still be planned.

## Gates (HEAD 10e5787)
`pnpm lint` exit 0 - `pnpm typecheck` exit 0 - `pnpm test:unit` exit 0 (302 files passed, 1 skipped; 3701 tests) - `pnpm contracts:check` exit 0.
Integration (`--config vitest.integration.config.ts`): displacement-recovery-plan, displacement-feed, refresh-project-displacements, task-create, task-update, task-complete, task-goals, project-tasks, portal-tasks-http, task-realtime-rooms, rollups-aux-tasks-geo-tools -> **exit 0, 11 files, 176 tests**.
`pnpm test:isolation` -> exit 1, 1 failed / 52 passed: `test/isolation/namespacing.spec.ts` ISO-14 flags `src/modules/reports/scheduled-reports.service.ts:234` (e-reports lane, NEW-E-100c). PRE-EXISTING: reproduced on the base commit fee788e with my changes stashed (same test fails, exit 1). Not touched here; the e-reports lane owns it. No schema change in this item, so no db:* checks apply.
Compile-test setup: `DisplacementModule` now imports `TasksModule` (which builds the realtime publisher and validates env), so the existing "DisplacementModule compiles" test now calls `applyFakeApiEnv()` like the TasksModule one; no assertion changed.

## Observability
Metrics `nominara_displacement_recovery_plans_total{outcome}` and `nominara_tasks_generated_deduplicated_total{origin}`; log "displacement recovery plan" with workspace_id, displacement_id and counts only (never a title, URL or competitor name). OpenTelemetry span: deferred to week 2 (decision R3).
Verified by `test/integration/displacement-recovery-plan.spec.ts` > "NEW-C-6 observability - counts the plan and logs workspace and displacement IDs plus counts only ..." (created and unchanged outcomes; no title/URL/competitor in the log). The deduplicated-task metric is emitted on the repeat path of the same run but not separately asserted. Real-API evidence (HTTP 201 envelope, `audit_log` row): collected in NEW-A-17.

## Not done
Frontend (`lib/api/competitors.ts` already matches; the control showing `recovery_task_count` is app-side). Docs to carry: api-specification.md section 3 needs `POST /displacements/{id}/recovery-plan` (201, Task[], `task:create`, Idempotency-Key) and the per-domain fingerprint.
