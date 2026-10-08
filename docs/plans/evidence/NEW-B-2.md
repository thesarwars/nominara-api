# NEW-B-2 evidence — GET /v1/workspaces/{id}/summary (checkpoint-2 close-out)

Lane worktree `api-wt-b2`, branch `7day/b-ws-3`, from integration/7day f201f35. Date 2026-10-08.

Commits (this pass): RED `12b3619`, fix `8d3aeca`. Earlier: `d3a1962` (CP1 route metadata), plus the a-api-2 provenance commits
(`85292d0`, `58144b5`, `967dd9c`).

## What CP2 found

1. Integration `workspace-summary.spec.ts` "AC: no per-project query" FAILED at f201f35 (21 statements for 12 projects vs 10 for 1). Cause: the
   a-api-2 provenance work (NEW-B-2 audit) called `engineDataSourcesForDates` once per project in a loop, which is an N+1. The unit spec pinned
   "once per project", so no unit test could see it.
2. QA: no recorded dangerous-area-auditor verdict on scoping.

## RED

- `12b3619`, `pnpm exec vitest run --config vitest.integration.config.ts test/integration/command-parse-http.spec.ts test/integration/workspace-summary.spec.ts`:
  exit 1, 5 failed / 10 passed. The workspace-summary failure is `expected 21 to be 10` (the statement count), the stated reason.
- `12b3619`, `vitest run src/modules/workspaces`: exit 1, 6 failed / 21 passed. Failures: the 5 provenance cases and the new
  "ONE batched provenance read" case, because the service never called `engineDataSourcesForProjects`.
- The unit test that pinned "once per project" was rewritten to pin one batched call (and no call for an empty matrix).
  That is a correction of a test that enshrined the defect, not a relaxed threshold: the statement-count assertion is untouched.

## Acceptance criteria

| Criterion | Proof | Result |
|---|---|---|
| `contracts/workspaces/workspace-summary-response.schema.ts` in its own commit | earlier lane commit; no contract change in this pass (`pnpm contracts:generate` no diff, `pnpm contracts:check` exit 0) | met earlier |
| Whole matrix in one response, no per-project query (assert query count) | `test/integration/workspace-summary.spec.ts` > "AC: no per-project query — the statement count is the same for 1 project and for 12" (RED 21 vs 10, GREEN equal); `workspace-summary.service.spec.ts` > "NEW-B-2 CP2 · AC no per-project query: ONE batched provenance read serves every project" | met |
| `@ScopedByQuery` + `app.current_scope_projects()`: scoped caller sees only in-scope rows; `projects_used` counts the scoped set | integration "scoped role: only in-scope projects, and projects_used / prompts_used count the scoped set" and "scoped role: the engine filter list is derived from the scoped set only"; `workspaces.controller.spec.ts` > "opts in to ScopedByQuery" | met |
| `assertMatchesTenant(id)`: another workspace's id refused | `workspaces.controller.spec.ts` > "another workspace's id is refused (NotFoundException) and nothing is read" | met |
| RBAC `project:read` | `workspaces.controller.spec.ts` > "requires project:read" | met |
| Dangerous-area-auditor reviews scoping | see "Scoping review" below | engineer review recorded; independent auditor verdict NOT recorded (no auditor agent is available to this lane) |

Added in this pass: integration "data_source is per project and per engine under RLS" proves the batched read keeps projects apart (live,
demo, nothing measured) and that another workspace's demo capture does not change the result.

## Scoping review (engineer's, for the dangerous-area-auditor to confirm)

- Every integration read runs as `nominara_app` (test "the tenant connection is the RLS-bound runtime role" asserts `rolsuper=false`, `rolbypassrls=false`).
- The matrix rows and the engine list are the only scope-bearing reads; both live in `ProjectsService.listForSummary` and filter on
  `app.current_scope_projects()`. The new batched provenance read takes the ids that read returned and runs on the same tenant transaction, so it
  can only see rows RLS admits and ids the scope admitted.
- Mutations run in this worktree (each reverted afterwards):
  - drop the scope clause from the project query: 2 integration tests fail (scoped projects; scoped engine list);
  - drop the scope clause from the engine query: 1 integration test fails (scoped engine list);
  - M10 (permission swapped to tracking:read) and removing `@ScopedByQuery`: killed by `workspaces.controller.spec.ts` (CP2 QA reproduced this).
- Open for the auditor: the CP2 QA verdict requires an independent reviewer. This lane cannot self-certify it; the merge step must record one.

## Gates (worktree api-wt-b2, tip `8d3aeca`)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (278 files passed, 1 skipped; 3331 tests passed, 1 skipped) |
| `vitest run --config vitest.integration.config.ts` on workspace-summary, command-parse-http, data-source, audit-interceptor-real-pipeline | 0 (4 files, 27 tests) |
| `pnpm contracts:generate` / `pnpm contracts:check` | no diff / 0 |
| `pnpm test:isolation`, `:breakers` | NOT RUN: known fixture crash (d-admin lane); tenant isolation is proved above under `SET ROLE`-equivalent (a real `nominara_app` login). The merge step runs the isolation suites. |

## Observability

Metric `nominara_workspace_summary_reads_total` and the redacted log line (workspace ID, counts only) exist; the unit spec asserts the metric.
OpenTelemetry spans are DEFERRED to week 2 (owner decision 3): a missing span is not a failed criterion this week.

## Needs a running real API

Nothing here; collected in NEW-A-17 if the Command Center is exercised end to end.
