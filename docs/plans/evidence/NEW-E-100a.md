# NEW-E-100a: methodology footer service and GET /v1/projects/{id}/reports/methodology

Tracing: metrics and a redacted log line this week; OpenTelemetry spans deferred to week 2 (owner decision 3).
Commits: contract dc23887, RED 5532ddc, implementation d9a56e8 (all merged earlier). No change to this story's code in
checkpoint 2; this file closes the evidence gap and states the one open criterion.

RED: 5532ddc, as reproduced by CP2 QA: the specs fail on the missing modules (I did not re-run the historical RED).

## Acceptance criteria

1. Footer fields data_through, engines, timeframe, sample_size, live_capture_ratio (null when unknown, never 0), scoring_version, weight_overrides, note.
   - test/unit/reports/methodology-footer.spec.ts: "NEW-E-100a AC1 - carries every NFR-AGY-05 field and validates against the contract", "an unknown ratio is null, never 0", "a measured ratio of 0 stays 0", "data_through null and a null engine data_source pass through as absent", "weight overrides ...".
   - test/integration/methodology-footer.spec.ts: "AC1 - carries every NFR-AGY-05 field, from rollup rows", "a project with no rollup has data_through null, live_capture_ratio null (never 0) and sample_size 0", "a measured live_capture_ratio of 0 is reported as 0, not null", "data_through is the latest metric_daily date ...", "the timeframe bounds the sample", "each engine carries live | demo | mixed | null", "weight overrides ...", "scoring_version ...".
   - Result at cec2a3a: methodology-footer integration spec in the 6-file run, exit 0.
2. Reads come from rollups only (metric_daily); project-scoped through the project param guard; an unreadable project is 404.
   - 404 half: integration "AC2 - a project in another workspace, or one that does not exist, is a 404", "a soft-deleted project is a 404"; src/modules/reports/reports.spec.ts "AC2 - the route is project-scoped through the project param guard". Note: the 404 is tested at service level, the route mount and guard metadata by the unit spec.
   - **NOT MET AS WRITTEN, OWNER DECISION NEEDED.** Every figure comes from metric_daily, but `engine_data_sources` (the live | demo | mixed | null marker of owner decision "one data_source vocabulary") is read from `answer_captures` through `engineDataSourcesForDates` (src/lib/analytics/data-source.ts). No rollup column carries it: `metric_daily.live_capture_ratio` means live-versus-cached (L1/L2 reuse, schemas/sources-and-rollups.md), not live-versus-demo, so it cannot stand in for it. Two ways to close it, both need a decision: (a) amend AC2 to read "figures come from metric_daily; the per-engine data_source marker comes from the shared provenance helper (the same one the matrix and scorecards use), the single non-rollup read"; or (b) add a demo-capture count to the rollup (a schema change to metric_daily, which no story names, so it is a specification gap). Recommendation: (a). I did not change code or the AC.
3. One implementation: `buildMethodologyFooter` exported and used by ExportService (via MethodologyService.footer()).
   - test/unit/reports/methodology-footer.spec.ts (pure builder); src/modules/reports/reports.spec.ts "mounts the methodology route and its service"; export-side use proven by test/integration/report-export-http.spec.ts "STORY-100 s1 - a PDF export ... carries the footer" (response footer equals the stored footer). The portal overview consumer is the e-portal lane's.

## Gates (cec2a3a)

lint exit 0; typecheck exit 0; contracts:check exit 0; test:unit exit 0 (3324 passed); methodology-footer integration spec exit 0 (part of the 6-file run, 51 tests). Isolation suites not run (see CP1-e-reports-fixes.md).
Evidence that needs a running real API (the route over a real server with a real session) is collected in NEW-A-17.
