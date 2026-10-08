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
- Tenant isolation, via the service: "STORY-062 isolation · under the application role, another workspace gets 404 ..." (26a2dd9). CORRECTION (audit): this test only proves RLS on `projects` (the service looks the project up first and 404s before `geo_analyses` is read); it passed with RLS disabled on `geo_analyses`. It is NOT the isolation proof for that table. The proof is the direct test below.
- Tenant isolation, `geo_analyses` itself: "STORY-062 isolation · geo_analyses itself, read and written directly as the application role ..." (3f00708); see the gate table.
- Observability: counters `nominara_geo_digest_read_total`, `nominara_geo_analysis_read_total`; redacted log `geo_analysis_persisted` (analysis, window, finding count; no workspace name).

## Gates (worktree api-wt-c3, branch 7day/c-geo-3, tip before this doc: cb327d1)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files passed, 1 skipped; 3313 tests passed, 1 skipped) |
| `pnpm exec vitest run --config vitest.integration.config.ts test/integration/geo- test/integration/seed-demo.spec.ts -t "STORY-06\|geo\|GEO"` (colima env, testcontainers) | 0 (5 files, 39 passed, 34 skipped by the filter) |
| `pnpm contracts:check` | 0 (no contract changed in this lane work) |
| `pnpm test:isolation` | 0 (13 files, 53 tests) at 91c9d9c, after cherry-picking the d-admin fixture fixes d25c2cb (as 8e96983) and 1d97921 (as 91c9d9c). The generic suite discovers `geo_analyses` from `tenant-tables.generated.ts`. |
| `pnpm test:isolation:breakers` | 0 (1 file, 24 tests) at 91c9d9c |
| `geo_analyses` policy, directly | `test/integration/geo-insights.spec.ts` "STORY-062 isolation · geo_analyses itself ..." (3f00708): as `nominara_app` under another tenant, SELECT 0 rows, UPDATE 0, DELETE 0, INSERT for the victim fails 42501. Fails under three policy mutations: RLS disabled ("expected 1 to be +0"), USING/WITH CHECK (true) ("expected 1 to be +0"), WITH CHECK (true) only ("promise resolved ... instead of rejecting"). |

Spans: OpenTelemetry spans are DEFERRED to week 2 (owner, 2026-10-08); a missing span is not a failed criterion. Metrics and redacted logs are present (see each section).
Anything needing a running real API (HTTP-level permission, 0-credit header) is collected in NEW-A-17.

## Audit fix — cross-tenant FK on geo_analyses (major)

Finding: `geo_analyses.project_id` was a single-column FK (0004). FK checks bypass RLS, so as `nominara_app` in tenant B's context a row with `workspace_id` = B and `project_id` = A's project was accepted (existence oracle; A's ON CONFLICT upsert then hit an invisible row and aborted A's rollup). The earlier isolation test only tried `workspace_id` = victim, so "geo_analyses RLS proven" did NOT cover this case; it is now covered. The application path (`writeGeoAnalysis`) was never exposed; the raw-SQL path is what is closed.

- Fix: `src/db/migrations/sql/0072_geo_analyses_tenant_fk.{up,down}.sql` (commit 7f31759): `UNIQUE (workspace_id, id)` on `projects` (it was missing) and `FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE`. Precedent 0079/0081. Existing rows cannot violate it (only writer takes workspace_id from projects).
- Test (RED first): `test/integration/geo-insights.spec.ts` "STORY-062 isolation · an attacker-workspace row against the victim's project is rejected by the composite FK, is indistinguishable from an unknown project, and cannot block the victim's rollup write". Asserts 23503 for the victim's project, the same code and constraint as a random project id, and that the victim's own persist still succeeds under `SET ROLE nominara_app`.
- RED commit 52830e6: `geo-insights.spec.ts` exit 1, 1 failed / 12 passed, "the victim's project id must be rejected: expected null not to be null" (the INSERT succeeded).
- Migration round trip: "STORY-062 migration 0072 · the down file restores the single-column FK and the up file reapplies the composite one" (executes the down then up file on the container).
- Docs: STORY-062.md (note + scenario 13) and schemas/geo-and-vectors.md DDL updated in Nominara-Dev-Docs-main; that hub has no .git here, so both edits must be carried to the docs repo.
- Same gap exists on other tables that FK to projects with a single column; not touched (outside this finding). Raise as a follow-up sweep.
- No schema/*.ts change (generated Drizzle schema carries no FK references), no tenant table added, so db:rls-generate has nothing to regenerate. db:schema-check/db:rls-check/db:drift-check need a database and were not run (55432 is off limits).

| Command | Result |
|---|---|
| geo-insights.spec.ts (integration, colima) | exit 0, 14 passed (RED: 1 failed / 12 passed) |
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (279 files passed, 1 skipped; 3369 tests passed, 1 skipped) |
| `pnpm test:isolation` | 13 files, 53 passed |
| `pnpm test:isolation:breakers` | 1 file, 24 passed |
| integration: generated-rls-and-tenant-context, geo-*, seed-demo | 6 files passed; seed-demo.spec.ts: 9 failed (NEW-A-8 x8, NEW-C-15 audit seed-then-verify) |

The 9 seed-demo failures are NOT from 0072: the identical 9 fail with 0072 removed (run on the RED commit 52830e6, exit 1, 9 failed / 30 passed). They are assertions about NEW-A-8 and NEW-C-15 behaviour that belong to other lanes and are not in this lane's code; to be resolved at the merge step.
