# STORY-061 (A6 sentiment drivers; A4 is NEW-C-12) — evidence (checkpoint 2)

RED: contract 9a609b3, RED tests 4469917 / e85bca3 (run on parent source: exit 1, "Cannot find module src/lib/geo/sentiment.js", the unit file cannot load), implementation 4413620.

## Acceptance criteria (track-plans.json)
1. Span, cues, reason, nearest citation; clusters by domain, cross-engine first. `test/unit/geo/sentiment.spec.ts`: "AC1 · every non-positive mention carries its span...", "AC1 · the citation is the NEAREST slot...", "AC1 · a citation that cannot be located is NOT guessed", "#10 · several negative mentions citing one source are clustered", "AC1 · a cluster spanning engines is ranked above a bigger single-engine cluster". Integration: `geo-sentiment.spec.ts` "#10 · negative mentions across two engines citing one thread are one cluster, read back from the stored row".
2. factual_error false with a reason, never guessed: "AC2 / #12 · factual_error is false with a reason on every mention".
3. One task per distinct reason class deferred; verdict 'action' with task_title only: "#11 · one task rule per distinct reason class", integration "#11 · one action per distinct reason class, a title and no task id".
4. Only parser-written columns; free and unmetered: "AC4 ..." tests, integration "#14 · free and unmetered: no credit ledger entry". Reads never recompute: "a READ never recomputes: facts changed after the rollup do not change the detail until the next rollup".
Below-minimum: "#13 ...30 is enough" (unit and integration).

## Checkpoint-2 finding closed
QA issue 5: every sentiment unit test now carries a requirement ID (commit cb327d1). This environment ran geo-sentiment.spec (the CP2 run had no Docker): pass.

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
