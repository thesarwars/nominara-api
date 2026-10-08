# STORY-062 — evidence (checkpoint 2)

Reads never recompute. `GeoService.detailFor` (src/modules/geo/geo.service.ts) returns `validFindings(row).find(f => f.structure)?.structure` from the stored `geo_analyses.findings`; it no longer imports `loadStructureInput` or `buildStructure`. No migration: the detail rides on the existing finding (contract `geoStructureDetailSchema`), so the CP1 options A/B/C question is closed without a schema change.

## Acceptance criteria

1. Contract first (`contracts/analytics/geo-insights.schema.ts`, strict). Proof: `test/unit/geo/insights.spec.ts` "rejects an unknown key and a lever rank above three", "the per-analysis shape validates and derives actions from task rules". Contract commits 6ce3dac (structure detail), 9a609b3 (sentiment detail).
2. Reads persisted rows only; `tracking:read`, 0 credits, no meter.
   - Persisted-only: `test/integration/geo-insights.spec.ts` "S10/S12 · reading never writes, moves no ledger and recomputes nothing"; `test/integration/geo-structure-wiring.spec.ts` "STORY-062 · a READ never recomputes structure: facts changed after the rollup leave the detail matching the stored row".
   - RED: 8fb0502 (run on its parent source 8fb0502~1): exit 1, 1 failed / 3 passed — that test. Fix 37e4b0e.
   - `tracking:read`: declared on both routes (geo.controller.ts, `@RequirePermission("tracking:read")`); no HTTP-level test exists at this tip. Collected in NEW-A-17 (real API).
3. A1/A2/A5 `insufficient` with needs; A7 `post_launch`; no A8 slug. `insights.spec.ts` "S5 · alignment, entity and topics with no row are insufficient and name the missing input", "freshness with no row is post_launch", "lists all seven slugs, none of them a fan-out"; integration "an empty project reads as unbuilt-with-reasons" (needs contains STORY-058 / STORY-047).
4. At most three levers; evidence-free finding never persisted. "S8 · promotes at most three levers" (unit) and "S8/S9" (integration); "S6 · an evidence-free finding is rejected and nothing is persisted" (integration), "S6" (unit).

## Checkpoint-2 additions
- Tenant isolation: "STORY-062 isolation · under the application role, another workspace gets 404 on the digest, the analysis and a write" (commit 26a2dd9). Mutation-proven.
- Observability: counters `nominara_geo_digest_read_total`, `nominara_geo_analysis_read_total`; redacted log `geo_analysis_persisted` (analysis, window, finding count; no workspace name).

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
