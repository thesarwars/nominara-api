# NEW-E-100b: on-demand export (CSV from rollups, PDF via pdfkit), footer baked in, stored in report_artifacts, pdf_exports metered

Tracing: metrics (`nominara_reports_exports_total`) and a redacted log line (workspace ID, no names, no figures) this week; OpenTelemetry spans deferred to week 2 (owner decision R3).
Commits: RED 52b1c43, implementation a8d9219 (earlier); checkpoint-2: RED 11d6add, fonts 11940b0, brand re-check 23f44d1.
RED 52b1c43, as reproduced by CP2 QA: 16 of 17 tests fail with 404 "Cannot POST" (the cross-workspace 404 test passes vacuously). Checkpoint-2 RED 11d6add (mine, run): unit 7 failed, integration 2 failed, exit 1 for the stated reasons.

## test/integration/report-export-http.spec.ts now runs and passes

Run at cec2a3a on colima with the testcontainers env: 1 file, 19 tests passed, exit 0 (it had never run before; the earlier blocker was the container disk). Dependencies the run needed: DOCKER_HOST and TESTCONTAINERS_RYUK_DISABLED=true, nothing else.

## Acceptance criteria

1. Renderer dependency approved (pdfkit). Recorded owner approval; pdfkit 0.20.2 in package.json. (No new dependency this checkpoint: the fonts are files, not packages.)
2. Scenarios 1-6, 8, 9, 18, every format carries the footer, survives hide_nominara_brand and section selection, stored footer, per-engine scores beside the blend, absent/low-confidence kept, zero credits and one pdf_exports unit, zero allowance is 403 not 429, scoped role cannot export an unreadable project:
   - HTTP (report-export-http.spec.ts): "STORY-100 s1 - a PDF export validates ...", "s1 - a CSV export carries the footer rows ...", "s2/s3 - brand removal and a hostile theme stylesheet leave the footer ...", "s3 - a request that tries to carry a footer or style override is a 400", "s8 - zero credits and exactly one pdf_exports unit", "s8 - a CSV export consumes no pdf_exports unit", "s8 - replaying the same Idempotency-Key ...", "s8 - the Idempotency-Key is required", "s9 - a tier with ZERO allowance is 403 feature_not_in_plan ...", "STORY-100 - an exhausted non-zero allowance is 429 quota_exceeded ...", "s18 - a project-scoped manager cannot export a project outside the scope", "STORY-100 - another workspace's project is a 404 and nothing is metered", "s6 - a project with no rollup exports an honest empty document, not zeros", "hide_competitors keeps competitor names out of the stored file". Plus the two new "CP1 downgrade" tests.
   - Document model and renderers: test/unit/reports/export-document.spec.ts (s1, s2, s3, s5, s6).
   - Result: exit 0.
3. CSV gated by exports.csv, produced from metric_daily: "STORY-100 - CSV is gated by exports.csv ...", "s1 - a CSV export carries the footer rows and the per-engine rows beside the blend". Exit 0.
4. export:data with the matrix's step-up rule; Idempotency-Key honoured: "owner export:data demands a fresh step-up; an analyst does not", "a viewer is refused 403 naming export:data", "s8 replay". Exit 0.
5. **The PDF uses only the curated self-hosted font and the stored theme; no network fetch during rendering.** MET (owner decision 4):
   - Font: Inter 4.1 Regular and Bold (unmodified .ttf, SHA-256 in src/lib/reports/fonts/README.md) and the OFL.txt licence are under src/lib/reports/fonts/, embedded as subsets by pdfkit. Tests: test/unit/reports/export-pdf-fonts.spec.ts (files exist, TrueType magic, size, licence text and the Inter copyright), test/unit/reports/export-document.spec.ts "NEW-E-100b AC5 - the PDF embeds the bundled Inter (regular and bold) and draws in no built-in font" (/FontFile2, BaseFont XXXXXX+Inter-Regular and +Inter-Bold, no /BaseFont /Helvetica). RED 11d6add: those tests failed (files absent, Helvetica in use).
   - Per-theme fonts are a later story: the stored theme's `font_family` is not drawn, and a test pins that the document palette carries no font field ("the theme's font_family cannot change the font").
   - Stored theme: colours and the brand line from the default brand_themes row (D6 null colours fall back to the platform default), and the brand line is now re-checked against the current `whitelabel.remove_branding` entitlement (CP1 finding).
   - No network: export-document.spec.ts "rendering performs no network call" (fetch spied and unused); rendering reads only the two bundled files from the application's directory.
   - Docker: the Dockerfile now copies src/lib/reports/fonts into dist/src/lib/reports/fonts (tsc copies no non-TS file; without it every PDF fails on ENOENT in the image). This is a file outside the story's Technical Notes; flagged. I did not build the image (no space or reason to; image build is NEW-A-17).
   - Test support: test/support/pdf-text.ts now inflates streams and decodes subset-font text through each font's /ToUnicode CMap, because an embedded TTF no longer writes readable one-byte text.

## Gates (cec2a3a)

lint exit 0; typecheck exit 0; contracts:check exit 0; test:unit exit 0 (278 files, 3324 tests); report-export-http 19/19 exit 0. Isolation suites not run (see CP1-e-reports-fixes.md); no tenant table touched.
Evidence needing a running real API (a real PDF fetched over HTTP and opened) is collected in NEW-A-17.
