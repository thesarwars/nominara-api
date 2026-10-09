# NEW-C-11 - Rendering quality read (GET /v1/projects/{id}/rendering-quality; scoring-models section 8; STORY-039 read side)

Lane 7day/c-src-3 (api-wt-c2), base integration/7day. Commits: contract 1538542, RED 82761a7, implementation 13351d0.
Dangerous area: scoring. RED committed separately before any implementation.

## RED
82761a7: `pnpm vitest run src/lib/analytics/rendering-quality.spec.ts src/modules/analytics/rendering-quality.spec.ts` -> 20 failed | 1 passed (21).
Reason: `buildRenderingQuality is not a function` / `service.renderingQuality is not a function` / controller not provided (the modules were empty stubs).
The 1 pass is the strict-query-schema test, which depends only on the contract commit. test/integration/rendering-quality.spec.ts was committed in the same RED commit.

## Criteria
| Criterion | Proof | Result |
|---|---|---|
| AC1 Contract first: per-engine and blended score, attribute coverage, rich_rendering_engines, nullable cause per attribute | 1538542 precedes the handler. contracts/analytics/rendering-quality-response.schema.ts; query and response .strict(). Tests: src/lib/analytics/rendering-quality.spec.ts "reports all seven weighted attributes per engine, with their section 8 weights, and satisfies the contract"; src/modules/analytics/rendering-quality.spec.ts "the response satisfies the contract and reuses the scorecards' figures", "the query is strict", controller "is mounted ... and reads under tracking:read" | met |
| AC2 Reuse the existing score, no second formula | The service takes each engine's score and the blend from ScorecardsService (toWindowMetrics / blendScorecards over the stored per-mention render_score) and hands them through unchanged. Tests: lib spec "the blended score and every per-engine score are handed through unchanged"; service spec "reuses the scorecards' figures". No new weights: ATTR_WEIGHT is imported from src/lib/parser/rendering.ts ("reports all seven ... with their section 8 weights"). | met |
| AC2 No mentions -> null, never 0 | lib spec "no mentions: score null, coverage null on every attribute, never 0"; service spec "with no mentions the score is null and the coverage null, never 0"; integration "a project with no mentions reads score null (not 0)". Distinct from a real zero: lib spec "a real zero is kept distinct from null". Mutation: coverage null -> 0 fails 2 tests. | met |
| AC2 Engines that cannot render attributes are excluded from the denominator | lib spec "an engine that cannot render attributes is excluded: score null, nothing counted, listed as not rich"; integration "gemini is excluded and live". Mutation: score passed through for an incapable engine fails 1 test. The counts query is limited to ATTRIBUTE_CAPABLE_ENGINES (service spec "the counts are brand-only, on measured captures, limited to attribute-capable engines"). | met |
| Per-engine always, priced elements on AI Mode only | lib spec "priced attributes are surface-unavailable on AI Overviews, and do not dilute the blend" (price pooled 4/10 not 4/20; mutation: pool all engines fails 1 test). New field surface_unavailable. | met |
| AC3 cause links a missing price or rating to an open aux_finding of the mapped structured_data rule | lib spec "a missing price links to an open finding of the mapped rule", "the mapping is price -> AUX-R-012/013 and rating -> AUX-R-013/015, and a rule off the map links nothing", "no cause where the attribute is not missing, where coverage is null, or on a low-weight attribute", "most severe is the cause"; service spec "the cause query reads OPEN findings of the mapped rules only" and "an open price finding becomes the cause of a missing price"; integration "links to the open mapped finding; a resolved or off-map one does not". Mutation: cause when nothing is missing fails 2 tests. | met |
| AC3 Raise the rule-to-attribute mapping as a spec ambiguity | See "Spec ambiguity" below. | raised |
| AC4 Demo engines from seeded render_attrs; Gemini from real parser output | Demo: integration "demo engines are computed from seeded render_attrs ..." (mode 41, blend 31.5 from seeded attrs/scores; data_source demo). Gemini: see "Gemini" below. | met in code; Gemini caveat below |
| One data_source vocabulary live/demo/mixed/null | Each engine entry and the blend carry the scorecards' data_source (service spec "each engine's data_source and the blend's come from the scorecards' provenance"; lib spec "carries each engine's data_source"). null = nothing measured. | met |
| Permission | tracking:read (controller test). Read, no @Audit. | met |
| Tenant isolation / RLS | Queries carry no workspace_id predicate (service spec asserts it). integration, as nominara_app: "another workspace's project is a 404 and its findings never leak as a cause". | met (integration run, exit 0) |

## Spec ambiguity to carry to the docs repo
1. The reference does not map attribute -> AUX rule. scoring-models section 8 says "every missing high-weight attribute links to the AUX finding that causes it"; STORY-039 AC7 gives "no price shown against an absent or contradicting offer". Implemented (RENDERING_CAUSE_RULES): price -> AUX-R-012 (offer data absent), AUX-R-013 (schema/text contradiction); rating -> AUX-R-013 (aggregateRating disagrees), AUX-R-015 (aggregateRating without provenance). Only price and rating (the two high-weight attributes) link; image/spec have no mapped rule. DECISION NEEDED: confirm or amend, and whether acknowledged/in_progress findings also count as "open" (implemented: status = 'open' only, literally).
2. Attribute coverage is not defined anywhere. Implemented: unweighted share of the engine's counted brand mentions carrying the attribute; the blend pools over the engines whose surface can show it. DECISION NEEDED if prominence-weighting is wanted.
3. NO PRODUCER EXISTS for AUX-R-012/013/015: aux_rule_catalog (migration 0070 + demo seed) holds only crawler-access rules and the demo seed's R-001/008/010/019/026/030/032. Until a structured_data audit produces them the cause is always null in practice; the link is built and tested but cannot show on the demo seed. (Also: cause is null by design where nothing is missing.)

## Gemini
Gemini is not in ATTRIBUTE_CAPABLE_ENGINES (conversational, prose only), so by section 8 / STORY-039 AC6 it is EXCLUDED: renders_attributes false, score null, mentions_counted 0, data_source live. Its mentions are still parsed and stored with real render_form/render_attrs, and are visible to the parser path; they are not scored. If the owner wants Gemini to contribute to the score this is a rule change to section 8, not a read-side change.

## Observability
Metric nominara_analytics_rendering_quality_reads_total{timeframe,scored}; existing nominara_analytics_demo_data_served_total gains surface=rendering_quality. Log line "rendering_quality_read" carries workspaceId, projectId, counts only (no names, no engine text, no finding titles). Verified by the service unit tests running the code path (incrementCounter/Logger executed); not observed against a running API (collected in NEW-A-17). OpenTelemetry spans deferred to week 2 by owner decision; a missing span is not a failed criterion this week.

## Frontend (not done in this lane)
The lane is the api worktree. pending.ts RenderingAttributes should become a subset of this contract: per-engine entries, the seven attributes with nullable coverage, nullable score, rich_rendering_engines, cause only where non-null.

## Files touched outside new ones
src/lib/parser/rendering.ts: PRICED_ATTRS exported (one keyword, no behaviour change). src/lib/analytics/data-source.ts: surface union gains "rendering_quality". src/modules/analytics/analytics.module.ts: registration.

## Gates (api-wt-c2)
- pnpm lint: exit 0
- pnpm typecheck: exit 0
- pnpm test:unit: exit 0, 280 files passed | 1 skipped, 3366 tests passed | 1 skipped
- pnpm contracts:generate then contracts:check: exit 0, no drift; contracts:diff against integration/7day's openapi: "minor" (new path only)
- Mutations on the scoring-adjacent logic: 4 mutants (null->0, exclusion off, cause when nothing missing, blend dilution), each killed (1-2 tests fail); restored, 12/12 green.
- Integration: `pnpm vitest run --config vitest.integration.config.ts rendering-quality` (colima env, disk 17 GiB free) -> exit 0, 5 passed (5), real Postgres 18, nominara_app role, including the tenant-isolation test. Run after fixing two fixture faults in the spec (engines already seeded by migrations -> ON CONFLICT DO NOTHING; render_score is a float4 column, so the seeded 0.66/0.16 read back as 41.0000025 -> toBeCloseTo precision 9 -> 4, a storage-precision correction, no formula or threshold change). A stray file `0` committed by mutation scripting was removed.
- test:isolation not run (known fixture crash at this tip; merge step runs it).

## Audit fixes (checkpoint-2 audit, three majors: M1, M2, M3/M5)
The service code was correct; the missing piece was tests that fail when a predicate is removed. Three integration tests were added to test/integration/rendering-quality.spec.ts, as nominara_app, with projects in ONE workspace (so RLS cannot hide the sibling). No production code changed, so there is no separate RED commit: the "red" is each mutation below failing its test.

| Finding | Test | Mutation | Result |
|---|---|---|---|
| 1 cause link crosses projects | "a sibling project's open mapped finding in the SAME workspace is never this project's cause" (sibling has an open critical AUX-R-012; read project's cause must be null, then its own low finding wins) | M1 `WHERE f.project_id = $1` -> `WHERE $1::uuid IS NOT NULL` | 1 failed, 7 passed, exit 1 (that test) |
| 2 mention counting crosses projects | "a sibling project's mentions in the SAME workspace are not counted into this project's coverage" (sibling has 2 priced mentions; read project must show mentions_counted 1, price coverage 0) | M2 `WHERE c.project_id = $1` -> `WHERE $1::uuid IS NOT NULL` | 1 failed, 7 passed, exit 1 (that test) |
| 3 window predicate | "only mentions inside the window, in the window's timezone, are counted" (workspace tz Pacific/Kiritimati UTC+14; one priced mention at local 00:01 on the first day = previous day in UTC, one at local 23:59 the day before the window, one 40 days ago; expects mentions_counted 1, price coverage 1) | M3 window predicate dropped | 1 failed, exit 1 |
| 3 timezone pinning | same test | M5 `AT TIME ZONE $4` -> `AT TIME ZONE 'UTC'` | 1 failed, exit 1 |

Each mutant was restored (git checkout) after its run. A first M5 attempt that left `$4` unbound failed all 8 tests on a SQL error and was discarded as proof; the valid M5 run keeps `$4` bound.
Fixture change: `workspace(timezone)` and `mention(..., capturedAt)` take optional arguments; existing callers unchanged.

Gates: pnpm lint exit 0; pnpm typecheck exit 0; unit (rendering-quality specs) exit 0, 21 passed; integration (`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true pnpm vitest run --config vitest.integration.config.ts rendering-quality`) exit 0, 8 passed (was 5), disk 14 GiB free.

## Audit fixes (checkpoint-3 audit, finding 4 / blocker: the isolation test could not fail)
The test "tenant isolation as nominara_app ..." passed only because of the `project_id = $1` predicate (wsA's finding is on project a, the read is for b), so removing RLS went unnoticed. A new test, "[NEW-C-11 AC1] RLS alone hides another workspace's finding and mentions that carry this project's id", plants rows as the owner that carry wsB's project id but wsA's workspace id (aux_findings and the capture/mention tables have no composite workspace/project FK, so the rows are legal): one open mapped finding (AUX-R-012) and two priced brand mentions. The project predicate matches them; only RLS excludes them. wsB reads b as nominara_app and must see cause null (engine and blended), mentions_counted 1, price coverage 0, score 10. The old test keeps its name (it still proves the 404 across workspaces). No production code changed, so the "red" is each RLS mutation below. Disk 18 GiB free.

Mutation = `ALTER TABLE .. NO FORCE ROW LEVEL SECURITY; ALTER TABLE .. DISABLE ROW LEVEL SECURITY` right after migrateUp, in a scratch copy of the spec (deleted afterwards):

| RLS disabled on | Result |
|---|---|
| aux_findings | exit 1, 1 failed / 8 passed (the new test: cause not null) |
| mention_facts alone | 9 passed. answer_captures' RLS still hides wsA's captures through the join |
| answer_captures alone | 9 passed. mention_facts' RLS still hides wsA's mentions |
| mention_facts + answer_captures | 1 failed / 8 passed (the new test: mentions_counted 3, expected 1) |
| all three | 1 failed / 8 passed (the new test) |

The mention query reads both tables in one join, so each table's policy covers the other: a single-table removal is correctly invisible at the endpoint, and removing both is caught. That is defense in depth, not a test gap; the per-table guarantee is the generic RLS suite's job (test:isolation), see below.

Gates: pnpm lint exit 0; pnpm typecheck exit 0; integration rendering-quality (colima env) exit 0, 9 passed (was 8).

## Open: test:isolation (audit finding, major) - not fixable in this lane
`pnpm test:isolation` crashes in its fixture on the base: migrations 0085/0086 (NEW-D-5 audit, cdc2766) cap support_grants TTL at 4 hours (ck_support_ttl_max) and the isolation global-setup fixture inserts a ~24 hour grant. This lane touches no migration and nothing under test/isolation; the fix belongs to the NEW-D-5 owner on the base. Until it lands and test:isolation (plus breakers for aux_findings) is green on the merged tip, the generic RLS proof for these tables is the table above, not the isolation suite.

## Checkpoint-3 fix: predicate-removal tests (branch 7day/c-src-4, a451b93)

The integration proofs for the sibling-project and window predicates already existed (above); this pass re-ran them on the merged tip and added the missing cheap layer: unit tests that read the SQL and its parameters, so a removed `project_id` predicate or an unbound window/zone fails in `test:unit`, not only in a container. Production code unchanged, so no RED commit; the "red" is each mutation.

| Criterion | Test |
|---|---|
| AC1 BOTH new queries carry a bound project_id predicate | rendering-quality.spec.ts "[NEW-C-11 AC1] BOTH new queries carry a bound project_id predicate ..." (`c.project_id = $1`, `f.project_id = $1`, `params[0]` = project) |
| AC2 window and timezone are bound, never literals | rendering-quality.spec.ts "[NEW-C-11 AC2] the window and the workspace timezone are bound parameters ($2 from, $3 to, $4 zone), never literals" (zone Pacific/Kiritimati; params[0..3] = project, from, to, zone; no zone/date text in the SQL) |
| Same, against real SQL as nominara_app | integration "a sibling project's mentions in the SAME workspace ...", "a sibling project's open mapped finding in the SAME workspace ...", "only mentions inside the window, in the window's timezone, are counted" |

Mutations on the current tip (each restored with git checkout):

| Mutation | Unit result | Integration result |
|---|---|---|
| counts: `WHERE c.project_id = $1` -> `WHERE $1::uuid IS NOT NULL` | 1 failed / 10 passed | 1 failed / 8 passed (sibling mentions test) |
| cause: `WHERE f.project_id = $1` -> `WHERE $1::uuid IS NOT NULL` | 1 failed / 10 passed | 1 failed / 8 passed (sibling finding test) |
| window predicate dropped | (covered by the BETWEEN mutation below) | 1 failed / 8 passed (window/timezone test) |
| `BETWEEN $2 AND $3` -> `BETWEEN $2 AND $2` | 1 failed / 10 passed | not run |
| `AT TIME ZONE $4` -> literal `'UTC'` | 1 failed / 10 passed | `$4` kept bound inside a CASE, then 1 failed / 8 passed |

Gates: unit rendering-quality 11 passed; lint 0; typecheck 0; test:unit 0 (302 files / 3703 passed, 1 skipped); integration rendering-quality exit 0 (9 passed at the tip); contracts unchanged. `test:isolation` ran on this branch: all of this lane's specs pass; the one failure is ISO-14 in `src/modules/reports/scheduled-reports.service.ts:234`, identical on `fee788e` (see NEW-C-10 evidence). The earlier "test:isolation crashes in its fixture" note no longer applies: the suite runs (12 of 13 files pass).
