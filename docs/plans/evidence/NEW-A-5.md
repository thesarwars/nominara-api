# NEW-A-5 evidence (checkpoint 2, lane 7day/a-api-3)

Observability: OpenTelemetry spans are deferred to week 2 (owner decision R3, 2026-10-08); a missing span is not a failed
criterion this week. Metric `nominara_analytics_demo_data_served_total{surface,workspace_id}` is verified by
`test/integration/data-source.spec.ts` > "NEW-A-5 observability — demo exposure is counted per surface with the workspace id only; live-only is silent".

## Acceptance criteria
| # | Criterion | Proof |
|---|---|---|
| 1 | Contract lands alone first; additive `data_source`; openapi regenerated; contracts:diff non-breaking | Contract commit 4569400 (alone, before d87227e). **Decision R5 applied this checkpoint (one rule: an ADDED OPTIONAL field is minor at any depth, top level included).** RED 128b70e: `test/unit/contracts-semver-diff.spec.ts` > "scenario 4 — adding an OPTIONAL field ... is a minor-level bump" and "NEW-A-5 · a new OPTIONAL property ... is minor, and so is the same at the root" -> 2 failed / 24 passed, exit 1. GREEN ed37969 (`src/contracts/diff.ts`): 29/29 in that file after the three mutation-killers below, exit 0. Earlier differ RED commits: f00faf1 (4 RED), e2126d3 (2 RED), 4666f24 (record value schema; QA noted it mixes the implementation into a `test` commit, a process gap, not repeated). `pnpm contracts:generate` leaves no diff; `pnpm contracts:check` exit 0. |
| 1b | `pnpm contracts:diff` from fb50262 | Result: **major**, and exactly one operation is major: `GET /v1/workspaces/{id}/summary`. Cause: its `data_source` (and each `engine_scores[].data_source`) changed from required enum `live|demo` to `live|demo|mixed|null` (a bare field became a nullable union). That is a real response-type change for a typed consumer, made by owner decision (one vocabulary, null = nothing measured; NEW-B-2 audit). Every other changed operation reads minor or patch (each path and method derived on its own with `deriveSemverBump`). I did NOT add it to `contracts/baseline/breaking-changes.json` (a human decision, per that file) and did not weaken the differ. **Approved by owner decision 2 of 2026-10-08** (`plans-7day/decisions-2026-10-08.md`: "APPROVED breaking change; record it in contracts/baseline/breaking-changes.json"). Recorded as `2026-10-08-summary-data-source-vocabulary` in `contracts/baseline/breaking-changes.json`; pinned by `test/unit/contract-breaking-changes.spec.ts` (incl. the new `data_nested` assertion on `engines[].data_source` and `projects[].engine_scores[].data_source`; mutating the recorded nullability turns 2 tests red, exit 1). |
| 1c | Differ guards (QA checkpoint-2 item 3): the arity guard and sibling-keys guard of `compareUnion` survived mutation | Added in 2b0acc9: "...a union that GAINS a branch...: the arity guard", "...LOSES a branch...", "...a changed SIBLING key (a default appears) is major: the sibling-keys guard". Mutation run: removing the arity guard -> 2 fail; removing the sibling guard -> 1 fails; both restored. |
| 2 | RED tests: demo-only project shows demo on every engine; real gemini + seeded others shows gemini live and the rest demo; a never-captured cell stays pending | `test/integration/data-source.spec.ts` "NEW-A-5 AC2 — a project with only demo-seeded captures...", "...a real gemini capture plus seeded others...", "...a cell never captured stays pending with a null data_source, not demo", "...a failed capture is not data...", "...an engine with both kinds ... is mixed", "...an empty project reports null everywhere...". Unit: `test/unit/analytics/data-source.spec.ts` (dataSourceOf, combineDataSources). RED history: 9e771c5 (7 RED, one data_source vocabulary). |
| 3 | Blended score: demo engines included or excluded, and the response says which; dangerous-area-auditor reviews | Implemented policy: ALL measured engines are in the blend, demo ones included, and the response discloses it (`blend.policy = "all_measured_engines"` plus live/demo/mixed engine counts). Test: "NEW-A-5 O1 — the blended score is over ALL measured engines, demo ones included, and the demo count is disclosed"; unit "NEW-A-5 AC3 — counts engines by provenance and states the inclusion policy". The planner's recommendation for the same question on divergence (NEW-C-12: count demo engines and label them) is the same policy; **Recorded decision:** `plans-7day/decisions-2026-10-08.md`, Lead's calls: "NEW-A-5 blend: all measured engines, demo count disclosed (policy all_measured_engines)" (a lead's call accepting the planner recommendation, not an owner decision; the code matches it exactly). Open point: `plans-7day/track-plans.json` still lists O1 as open and was not updated from this lane; if the owner wants O1 closed as an owner decision rather than a lead's call, the owner must confirm. The dangerous-area-auditor reviewed the blend in both the days 1-2 and days 3-4 audits (per the checkpoint-2 QA notes); I could not re-run it from this lane. |
| 4 | Tenant isolation unchanged; isolation suite green | Read paths unchanged (tenant transaction, `engineDataSources*` run on the caller's `tx`). `test:isolation` cannot run at this tip (fixture crash on `ck_support_ttl_max`, fixed by the d-admin lane); the merge step runs it. QA ran it on the lane tip: 11/12 files (51 tests) green, the one failure being the Docker-network pgbouncer spec; breakers 24/24. |

## Related fix in this item: NEW-B-2 summary provenance was N+1 (QA checkpoint-2 item 2)
967dd9c looped `engineDataSourcesForDates` per project. 9dbc6b8 adds `engineDataSourcesForProjects` (`src/lib/analytics/data-source.ts`):
one statement for all scoped projects (`project_id = ANY($1::uuid[])`, grouped by project and engine; a project with nothing measured
keeps an empty map, so null stays null and is never turned into demo). RED (existing test, on the tip before the change):
`test/integration/workspace-summary.spec.ts` > "AC: no per-project query — the statement count is the same for 1 project and for 12" ->
`AssertionError: expected 21 to be 10`, 1 failed / 6 passed, exit 1. GREEN: 7 of 7, exit 0. The unit double in
`src/modules/workspaces/workspace-summary.service.spec.ts` now answers the batched call (14/14).

## Gates
All run in /Users/sarwaralam/Desktop/Projects/ElegantTech/nominara/api-wt-a2 on 7day/a-api-3, Docker via testcontainers (pgvector:pg18).
- `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm contracts:generate` no diff; `pnpm contracts:check` exit 0.
- `pnpm test:unit` exit 0: 277 files passed, 1 skipped; 3316 tests passed, 1 skipped. (One earlier full run, concurrent with a
  container run on a machine at load average 17, failed `src/api/guards/rbac.guard.spec.ts` "a manager scoped to projects...";
  the file passes alone, 21/21, and passes in the clean full re-run. It is a file this lane did not touch.)
- `vitest run --config vitest.integration.config.ts` on seed-demo, workspace-summary, identity-me, workspace-members-detail-revoke,
  data-source, openapi-route-and-strictness, project-seeds, workspace-invitations, workspace-members-and-roles: exit 0,
  9 files / 110 tests passed.
- `pnpm test:isolation` / `test:isolation:breakers`: not run; they crash in fixture setup at this tip (`ck_support_ttl_max`, d-admin lane).
  No tenant table, migration or RLS policy was touched by this lane (no db:rls-generate needed). The merge step runs the isolation suites.
- Evidence that needs a running real API (session -> GET /v1/me, data_source on live responses) is collected in NEW-A-17.

## Audit fixes (checkpoint-3 re-audit)
- Audit 1 (engineDataSourcesForProjects had no behavioural test): `test/integration/data-source.spec.ts` > "NEW-A-5 · engineDataSourcesForProjects — real SQL over several projects"
  (4 tests: live/demo/mixed per project and engine with failed + out-of-window captures giving null; empty map for a project with no captures;
  inclusive date window; workspace-timezone window). **NOT YET RUN**: `df -h /System/Volumes/Data` showed 6.6 GiB free (< 8 GiB), so the
  testcontainers spec was not started, per the hard rule. Typecheck and eslint on the file are exit 0. Still owed, on a machine with >= 8 GiB free:
  run the file (expect green), then the two mutants: (a) swap the two FILTER predicates in `engineDataSourcesForProjects`, (b) delete the
  `(c.captured_at AT TIME ZONE $4)::date BETWEEN` line; each must turn tests red. No RED/mutant result is claimed here.
- Audit 2: row 1b above now cites owner decision 2 and the new `breaking-changes.json` entry (`test/unit/contract-breaking-changes.spec.ts`, 18/18 exit 0; mutation on the recorded nullability -> 2 failed, exit 1).
- Audit 3: row 3 cites the recorded lead's call; track-plans.json O1 not edited from this lane (owner confirmation needed only if O1 must be an owner decision).

- Audit 4: decision citations renamed R3/R5 and recorded in docs/plans/decisions-2026-10-08.md (versioned); STORY-023/NFR-REPO-02 edits carried to docs/plans/docs-carry/. RED 795aa9a (3 failed, exit 1) -> green (`test/unit/decision-citations.spec.ts`, 3 passed). AC3 (O1 blend): the lead's call is now accepted in the decisions file and annotated in track-plans.json O1; owner may still overrule.
