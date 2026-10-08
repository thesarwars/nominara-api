# STORY-060 — evidence (checkpoint 2)

## Acceptance criteria

1. RED first: form distribution per engine, brand position-class share with prior window, insufficient below minimum. `test/unit/geo/structure.spec.ts`: "#7 · the dominant form...", "per engine: ...", "#9 · position class movement is trended against the prior window", "no prior brand answers: prior is null, not 0", "#10 · below the minimum ... suppresses itself", "boundary: exactly the minimum is sufficient", "the minimum is the catalogue's stated 30".
2. Writes `geo_analyses` 'structure' through `refresh-project-geo.ts`. Checkpoint-1 failure was that nothing called it. Now called from the rollup handler, the demo seed and the purge. Proof: `test/integration/geo-structure-wiring.spec.ts` "a Gemini window parsed by the real parser is analysed by the rollup handler, as live data", "a second handler run replaces the row rather than adding one", "a window under the minimum is persisted as insufficient"; `test/integration/seed-demo.spec.ts` "STORY-060 · the seed computes the A3 structure row from its own facts...".
   - RED 8d844e0 (on parent source): exit 1, 3 failed / 2 passed (wiring: "a Gemini window parsed by the real parser..." and "a window under the minimum is persisted as insufficient"; seed-demo: the STORY-060 seed test). Fix c7096ab.
3. page_forms [] and template null, verdict no_action with a reason, never a fabricated gap: structure.spec "#8 · a table-dominant cluster never fabricates a gap".
4. Only parser columns (answer_form, position_class): same unit and wiring specs read only those.
5. Demo engines from seeded mention_facts, Gemini from real parser output: wiring spec (real `capture-parse` handler then rollup) and the seed-demo test; per-engine data_source "mixed when an engine has both kinds of row" (structure.spec).

## Checkpoint-2 finding closed (QA issue 4: the purge check was vacuous)
The old purge assertion passed with the purge refresh removed (the seed-created project is deleted outright). New test "STORY-060 · --purge on a PRE-EXISTING project recomputes A3 over what is left" (commit e2f4355) uses a surviving project. Mutation (comment out `refreshProjectGeoWindows` in `purgeOneProject`): fails, "expected 6 to be +0"; with the code: passes.
QA issue 2 (stale comment in rollup-metric-daily.handler.ts) fixed in cb327d1.
QA issue 3 (cost of 3 windows x 2 analyses): measured per window, not unmeasured — each recompute logs `nominara_geo_structure_recompute_duration_ms` / `nominara_geo_sentiment_recompute_duration_ms` with the window. No budget threshold has been set; left for the load review.

Observability: counters `nominara_geo_structure_recompute_total`, duration log lines (project_id, counts, window; no answer text).

## Gates (worktree api-wt-c3, branch 7day/c-geo-3, tip before this doc: cb327d1)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files passed, 1 skipped; 3313 tests passed, 1 skipped) |
| `pnpm exec vitest run --config vitest.integration.config.ts test/integration/geo- test/integration/seed-demo.spec.ts -t "STORY-06\|geo\|GEO"` (colima env, testcontainers) | 0 (5 files, 39 passed, 34 skipped by the filter) |
| `pnpm contracts:check` | 0 (no contract changed in this lane work) |
| `pnpm test:isolation` | NOT RUN: crashes in fixture setup at this tip (support_grants TTL, d-admin lane). Tenant isolation proven instead in `test/integration/geo-insights.spec.ts` "STORY-062 isolation" under `SET ROLE nominara_app` (mutation: dropping the SET ROLE makes it fail, "promise resolved ... instead of rejecting"). |

Spans: OpenTelemetry spans are DEFERRED to week 2 (owner, 2026-10-08); a missing span is not a failed criterion. Metrics and redacted logs are present (see each section).
Anything needing a running real API (HTTP-level permission, 0-credit header) is collected in NEW-A-17.
