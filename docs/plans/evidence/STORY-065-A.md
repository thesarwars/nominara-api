# STORY-065-A evidence (lane 7day/b-tasks-3)

Base: integration/7day 7cda775 (worktree api-wt-b1). Commits: contracts 2c02509, RED 454aa31, implementation cefc1bc.
Observability: metrics (`nominara_goals_created_total{kind,sample_state}`, `nominara_goals_abandoned_total`) and redacted log lines (workspace/project/goal IDs only, no title). OpenTelemetry spans are deferred to week 2 (owner decision 2026-10-08), so a missing span is not a failed criterion this week.

## STATUS: code complete; integration spec EXECUTED GREEN (see Final run, bottom). The paragraph below is superseded.
`df -h /System/Volumes/Data` read 7.1, 6.9 and 7.7 GiB free during this run (hard rule: under 8 GiB, do not run testcontainers). So `test/integration/task-goals.spec.ts` (the SQL-level proof for criteria 2-8 below) has not run, neither RED nor green. It must be run before merge: `pnpm vitest run --config vitest.integration.config.ts test/integration/task-goals.spec.ts` with the colima DOCKER_HOST, once free space is >= 8 GiB. Treat criteria marked (integration) as UNPROVEN until then.

## Scope decisions (flagged, not silently chosen)
- Kinds: the plan says "for the kinds the owner approves". No approval is on record, so only the two kinds with a stored measured baseline are creatable: `engine_score` (projects.visibility_blended) and `topic_authority` (topic_clusters.visibility_score, needs `prompt_cluster_id`). The other five CHECK kinds, and `engine_key`, are a 400. Needs an owner decision to widen.
- Sample sufficiency: `n >= 30` cells (scoring-models.md confidence band, low only when n < 30), n taken from projects.cells_30d at capture, stored with the snapshot. For a topic_authority goal `cells` is stored as null (audit fix: a cluster has no cell count of its own and the project's n is not the cluster's n), so it reads `insufficient` until a cluster-level n exists. Awaiting owner confirmation of this choice in the story. `value` null or `cells` null => insufficient.
- `current` starts equal to the baseline snapshot (so all three numbers are present on read); only the rollup (deferred) moves it. `progress_pct` is the stored column (0 at creation), `null` when insufficient.
- All three endpoints require `task:create` (api-specification section 3, as written, including GET). A viewer therefore cannot read goals; this is the spec's row, flagged for the docs owner.
- No migration, no schema change.

## Acceptance criteria
| # | Criterion | Proof | RED |
|---|---|---|---|
| 1 | goal-response + create-goal-request contracts in own commit | 2c02509 touches only contracts/tasks; src/modules/tasks/goals.spec.ts "STORY-065-A · goal contracts" (4 tests: strict, kind/cluster rules, abandon-only PATCH, response shape) | 454aa31 |
| 2 | test #1 baseline captured at creation | (integration) task-goals.spec.ts "[STORY-065 #1] an engine_score goal captures its baseline...", "...topic_authority goal captures its baseline from topic_clusters.visibility_score", "...a cluster of another project, a foreign tenant's cluster and an unknown cluster are refused" | 454aa31 |
| 3 | test #3 baseline, current, target on read | (integration) "[STORY-065 #3] a read carries baseline, current and target"; unit: "[STORY-065 #3] the response declares baseline, current and target" | 454aa31 |
| 4 | test #9 insufficient shows sample state, not a percentage | (integration) "[STORY-065 #9] under-sampled (n=29), unmeasured (null) and unknown-n ..." and the boundary "n=30 is sufficient" | 454aa31 |
| 5 | test #12 reading twice recomputes nothing | (integration) "[STORY-065 #12] reading twice recomputes nothing" (live metric changed between reads; reads equal; row and updated_at untouched). Rollup refresh itself is deferred | 454aa31 |
| 6 | test #7 abandon audited | unit: "[STORY-065 #7] create and abandon are audited" (goal.created, goal.abandoned, paramName goalId); (integration) abandon sets status, second abandon 409, achieved goal 409 | 454aa31 |
| 7 | test #8 two goals persist | (integration) "[STORY-065 #8] two goals on one project both persist" | 454aa31 |
| 8 | RBAC task:create | unit: "[STORY-065 RBAC] list, create and abandon all require task:create ... and are project-scoped by :id" | 454aa31 |
| extra | tenancy | (integration) "tenancy: another tenant's project is a 404 on list/create/abandon, a foreign goal cannot be abandoned, an out-of-scope project is the scope 403", run as nominara_app. Tests #10 (cascade) and #11 (unlink keeps task) are schema facts, also in the integration spec | 454aa31 |

Not built (story criteria outside step A, per the plan): rollup refresh of current/progress_pct (tests #2), contribution-relative task ordering (#4, #5), achieved state/timestamp setting (#6; the 409 on an achieved goal is built).

## RED
454aa31: `pnpm vitest run src/modules/tasks/goals.spec.ts` -> exit 1, "Test Files 1 failed (1)", failing because `./goals.controller.js` does not exist (import error; no tests collected). The integration spec at the same commit fails the same way on `goals.service.js`, but was not run (disk gate). After cefc1bc: goals.spec.ts 7 passed (7).

## Gates (api-wt-b1 at cefc1bc)
- `pnpm lint` exit 0
- `pnpm typecheck` exit 0
- `pnpm test:unit` 278 files passed, 1 skipped; 3324 tests passed, 1 skipped (no failures)
- `pnpm contracts:generate` then `pnpm contracts:check` exit 0 (openapi.generated.json regenerated, committed in cefc1bc). `contracts:diff` needs a previous file and was not run.
- integration `task-goals.spec.ts`: NOT RUN (disk < 8 GiB, see top).
- test:isolation: not run (no tenant table or migration touched; known fixture crash at this tip).
- Evidence needing a running real API (HTTP Idempotency-Key replay on POST goals, real audit rows): collected in NEW-A-17.

## Audit fixes (round 3)
- Item 2 (topic_authority cells): RED test commit is the one before the fix ("STORY-065 #9 ... never borrows the project's cell count"); WRITTEN, NOT EXECUTED (disk). Fix: cells=null for topic_authority in GoalsService.createGoal. `pnpm vitest run src/modules/tasks/goals.spec.ts` and lint/typecheck/unit: see gate lines below.
- Item 1 (never-run integration spec): STILL BLOCKED. `df -h /System/Volumes/Data` = 7.2 GiB free (< 8 GiB rule) at 2026-10-08. Required, not yet done: green run of task-goals.spec.ts, and RED mutation runs (remove assertProject; remove `AND project_id = $2` in updateGoal; same in cluster query), each exit 1. test:isolation: no tenant table or migration touched; judged not applicable, and it crashes at this tip.
- Gates after fix: lint 0, typecheck 0, vitest src/modules/tasks 3 files/53 tests exit 0.

## Final run (2026-10-08, disk 18 GiB free, gate cleared)
- `pnpm vitest run --config vitest.integration.config.ts test/integration/task-goals.spec.ts` (colima DOCKER_HOST) at 6729683: 1 file, 14 tests passed, exit 0. All criteria marked (integration) above are now PROVEN by that run.
- Mutation runs against the integration spec (each restored with git checkout; each exit 1):
  - remove `assertProject` from createGoal: 1 failed (tenancy test).
  - remove `AND project_id = $2` from the abandon query: 3 failed (#7 abandon, achieved-goal 409, tenancy).
  - cluster query without the project filter (replaced by `AND $2::uuid IS NOT NULL` so the parameter count stays valid): 1 failed (cluster of another project/tenant refused). A first variant that dropped the clause but kept the parameter failed 3 tests on a pg parameter-count error and is not counted as proof.
  - comment out `cells = null` for topic_authority (audit fix): integration #9 "never borrows the project's cell count" fails (1 failed, 13 passed) -> confirms the audit RED fails for the stated reason. The unit goals.spec.ts does not cover this (7 passed), so the integration spec is the proof.
- Gates at 6729683: lint 0, typecheck 0, `pnpm test:unit` 0, `contracts:check` 0, tasks module vitest 0.
- test:isolation: no tenant table or migration touched; tenant isolation is proven by the integration tenancy test run as nominara_app (isolation suites crash in fixture setup at this tip; merge step runs them).
- Open owner decisions unchanged: goal kinds beyond engine_score/topic_authority; n>=30 sufficiency threshold; GET goals requiring task:create (spec row as written).

## Audit fix (round 4): soft-delete guard on goals
- Finding: no test covered `deleted_at IS NULL` in `GoalsService.assertProject`; both that clause and the `assertProject` call in `updateGoal` could be removed with 14/14 green.
- Test added: test/integration/task-goals.spec.ts "[STORY-065 soft-delete] a soft-deleted project's goals are a 404 on list, create and abandon, and nothing is written or changed" (UPDATE projects SET deleted_at = now(); list/create/abandon reject NotFoundError; goals row count still 1; status active; updated_at unchanged). Run as nominara_app.
- The guard already existed, so the test passes on the unmutated code; the RED proof is mutation (service restored with git checkout after each):
  - remove `AND deleted_at IS NULL` from assertProject: exit 1, "1 failed | 14 passed (15)", the new test.
  - remove the `assertProject` call from updateGoal: exit 1, "1 failed | 14 passed (15)", the new test.
- Unmutated: `pnpm vitest run --config vitest.integration.config.ts test/integration/task-goals.spec.ts` exit 0, 15 passed (15). Disk free 8.7 GiB at start (gate is 8).
