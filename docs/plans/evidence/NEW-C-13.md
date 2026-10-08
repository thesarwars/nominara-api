# NEW-C-13 — GEO recompute hook and Top Three Levers ranking (STORY-062 AC8/9/10/12)

RED: 2804d73 (unit + integration specs, no implementation). Run on that tree: `pnpm exec vitest run test/unit/geo/lever-rank.spec.ts` exit 1, 1 suite failed, 0 tests ran: "Failed to resolve import ../../../src/lib/geo/lever-rank.js" (the module did not exist). The integration spec fails the same way at import (collection failure). Implementation: 97220c7 (src/lib/geo/lever-rank.ts, hook in src/lib/rollup/refresh-project-geo.ts). No migration, no contract change, no new dependency.

## Acceptance criteria

1. After each rollup, refresh-project-geo recomputes structure, sentiment and divergence (if landed) for the window, plus a one-off backfill over seeded days.
   - The hook already existed: rollup-metric-daily.handler.ts calls refreshProjectGeoWindows (7/30/90) after each rollup, and seed-project.ts / purge.ts call it for the seeded days. This story adds the ranking pass at the end of refreshProjectGeo, so every recompute re-ranks that window. Proof: test/integration/geo-lever-rank.spec.ts "[C13-1]" (rollup hook promotes the actionable analysis to lever 1, no-action one unranked) and "[C13-2]" (insufficient window carries no lever).
   - Divergence: NOT WIRED. crossEngineDivergence (NEW-C-12) is a pure function with no builder that writes a geo_analyses row, so there is nothing to recompute; it joins refreshProjectGeo with its own story (STORY-061 divergence ACs 5, 6).
   - Seeded-days backfill: seed-project.ts already calls refreshProjectGeoWindows, which now ranks. The seed-demo integration suite is red at this tip for an unrelated reason (see Gates), so the seeded path is not proven end to end here; the ranking itself is proven through the same function in [C13-1].
2. lever_rank ranks at most three across analyses by impact; a lever's task is null until the task engine exists.
   - Pure ranking, test/unit/geo/lever-rank.spec.ts: "[L1]" severity order 1..3, "[L2]" at most three of seven analyses, "[L3]" no-action never promoted, "[L4]" insufficient never promoted, "[L5]" one lever per analysis with the rank on its finding, "[L6]" ties by evidence then slug, input-order independent, "[L7]" stale rank stripped, "[L8]" empty, "[L9]" findings still valid, "[L10]" idempotent, "[L11]" input not mutated.
   - Digest reads it: integration "[C13-3]" (one lever, analysis_href geo?analysis=sentiment, task null).
   - RAISED (STORY-062 says each lever links to a task): the task is null because the task engine cannot resolve a rule code to an open task yet (GeoService.digest passes () => null). The contract allows null. Needs a decision when the task engine lands.
   - IMPACT HAS NO FORMULA IN THE REFERENCE (schemas/geo-and-vectors.md only says "1-3 promotes"). Defined here: severity of the analysis's best actionable finding (critical 4 .. info 0), then evidence_cells, then slug order. Needs an owner confirmation and a line in the docs repo; changing it is one function.
3. Recomputing the same window replaces its rows; no duplicates.
   - "[C13-4]" three refreshes leave exactly 6 rows (structure + sentiment x 3 windows) with identical ranks; "[C13-5]" a lever is cleared on the next recompute when its evidence goes; the composite key upsert in writeGeoAnalysis is unchanged.

## Also
- Free and unmetered: "[C13-6]" no credit_ledger row.
- Tenant isolation (no isolation suite runs at this tip): "[C13-7]" runs the ranking pass for another workspace under SET ROLE nominara_app against a deliberately stale row; the row is untouched. Mutation: removing the SET ROLE makes it fail (the owner role repairs the row).
- Mutations on the pure function (all caught): cap 3 -> 4, dropping the actionable filter, dropping the evidence tie-break, dropping the sufficient check (the last one survived until [L4] was given an insufficient row that carries an actionable finding; fixed in the same commit).
- Not covered: GeoService.persistAnalysis (an ad hoc write) does not re-rank; only the recompute does. Ranking there would overwrite lever_rank values that geo-insights.spec.ts persists on purpose.
- Observability: counter nominara_geo_levers_ranked_total{promoted}, redacted log geo_levers_ranked (project id, window, counts; no workspace name, no finding text). OpenTelemetry spans DEFERRED to week 2 (owner, 2026-10-08); a missing span is not a failed criterion.
- Needs a running real API: HTTP-level tracking:read on the digest route and the 0-credit header: collected in NEW-A-17.

## Gates (worktree api-wt-c3, branch 7day/c-geo-3)

| Command | Exit |
|---|---|
| pnpm lint | 0 |
| pnpm typecheck | 0 |
| pnpm test:unit | 0 (278 files passed, 1 skipped; 3324 tests passed, 1 skipped) |
| vitest --config vitest.integration.config.ts test/integration/geo-lever-rank.spec.ts | 0 (7 passed) |
| same config, test/integration/geo- (all geo specs) + rollups-aux-tasks-geo-tools.spec.ts | 0 for those; 6 of 7 files passed |
| same config, test/integration/seed-demo.spec.ts | 1 (8 failed, 29 passed). PROVEN PRE-EXISTING: the identical 8 fail with this change stashed, on the base commit 2804d73 (the RED commit, which adds only tests). They are the NEW-A-8 --facts-only cases (e.g. "#1 expected [] to deeply equal [chatgpt, claude, ...]": no demo facts written). Not touched by this story; belongs to the seed lane. A first full run showed a 9th ("UTC+14 re-audit") that passed on re-run. |
| pnpm contracts:check | 0 |
| pnpm test:isolation | NOT RUN: crashes in fixture setup at this tip (support_grants TTL, d-admin lane). Isolation proven in [C13-7]. |
