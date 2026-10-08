# STORY-065-A evidence (lane 7day/b-tasks-3)

Base: integration/7day 7cda775 (worktree api-wt-b1). Commits: contracts 2c02509, RED 454aa31, implementation cefc1bc.
Observability: metrics (`nominara_goals_created_total{kind,sample_state}`, `nominara_goals_abandoned_total`) and redacted log lines (workspace/project/goal IDs only, no title). OpenTelemetry spans are deferred to week 2 (owner decision 2026-10-08), so a missing span is not a failed criterion this week.

## STATUS: code complete, integration spec WRITTEN BUT NOT EXECUTED
`df -h /System/Volumes/Data` read 7.1, 6.9 and 7.7 GiB free during this run (hard rule: under 8 GiB, do not run testcontainers). So `test/integration/task-goals.spec.ts` (the SQL-level proof for criteria 2-8 below) has not run, neither RED nor green. It must be run before merge: `pnpm vitest run --config vitest.integration.config.ts test/integration/task-goals.spec.ts` with the colima DOCKER_HOST, once free space is >= 8 GiB. Treat criteria marked (integration) as UNPROVEN until then.

## Scope decisions (flagged, not silently chosen)
- Kinds: the plan says "for the kinds the owner approves". No approval is on record, so only the two kinds with a stored measured baseline are creatable: `engine_score` (projects.visibility_blended) and `topic_authority` (topic_clusters.visibility_score, needs `prompt_cluster_id`). The other five CHECK kinds, and `engine_key`, are a 400. Needs an owner decision to widen.
- Sample sufficiency: `n >= 30` cells (scoring-models.md confidence band, low only when n < 30), n taken from projects.cells_30d at capture, stored with the snapshot. For a topic cluster the project's cells_30d is used (a cluster has no cell count of its own). `value` null or `cells` null => insufficient.
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
