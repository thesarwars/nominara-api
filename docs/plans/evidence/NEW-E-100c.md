# NEW-E-100c: scheduled reports CRUD, send-now, delivery history, cap skip with explicit notification

Tracing: metrics (`nominara_reports_scheduled_deliveries_total{status}`, `nominara_reports_scheduled_changes_total{event}`) and redacted log lines (workspace ID and scheduled-report ID only, no label, recipients or figures) this week; OpenTelemetry spans deferred to week 2 (owner decision R3).
Commits: contract 1c1c7bd (send-now response = the delivery attempt), RED 1a60a6f, implementation 75b4e8b, integration spec ff05062, corrected in the following commit.
RED 1a60a6f, run: `vitest run test/unit/reports/next-send-at.spec.ts src/modules/reports/scheduled-reports.spec.ts` exit 1, 2 files failed, 0 tests ran, reason "Cannot find module" (next-send-at.ts, scheduled-reports.controller/service absent). After implementation: 15 + 13 tests pass. One assertion in the s10 test was corrected after implementation (the notification kind is a SQL literal, so the check reads the statement text as well as the params); no threshold or expectation was relaxed.

## Integration spec (run)

test/integration/scheduled-reports-http.spec.ts: `vitest run --config vitest.integration.config.ts scheduled-reports-http` exit 0, 8 tests passed (disk 18 GiB free at the run). It was written before it could be run, so no RED run exists for it; its first run failed 6 of 8 for test-harness reasons only (no-body requests sent with a JSON content-type; the HTTP harness connects as a superuser so RLS-dependent assertions were vacuous; the free-plan owner's session carried a stale entitlement version; audit_log has no created_at). The tests were corrected, no assertion was relaxed: cross-workspace project refusal (400) and cross-workspace report invisibility (list, update 404, delete 404) and the RLS reads are now asserted under `SET LOCAL ROLE nominara_app`, as the harness note in agency-theme-rls.spec.ts requires. Tenant isolation is proved there, not through test:isolation. No tenant table or migration was touched.

## Acceptance criteria

1. RED tests first for scenarios 7, 8, 9, 10, 15; send-now at the cap writes skipped_cap + a notification naming cap and reset date; every attempt listed with outcome and reason:
   - s7: test/unit/reports/next-send-at.spec.ts (weekly, biweekly, monthly, quarterly, workspace-local hour in Dhaka/Kolkata/New York/Auckland, DST gap and overlap, strictly-after, range refusal). Exit 0, 15 tests.
   - s8: src/modules/reports/scheduled-reports.spec.ts "s8 - a run costs zero credits and consumes ONE pdf_exports unit ..." and "s8 - a csv-only report consumes no pdf unit". HTTP: integration "s8/s15 - send-now: zero credits, ONE pdf unit for two projects ..." (run, exit 0).
   - s9: "s9 - a tier with ZERO allowance is 403 feature_not_in_plan ..." (unit); integration "s9 ..." (run, exit 0).
   - s10: "s10 - at the cap the run is skipped ..." (unit: delivery status, reason with cap and reset date, notification kind/body, nothing built or sent, no commit); integration "s10 ..." (run, exit 0).
   - s15: "s15 - list() returns every attempt with its outcome and failure reason" and "s15 - a failed build is listed as 'failed' with its reason, the reservation is released ..." (unit).
2. Permission agency:branding; recipients validated as emails; project_ids readable in the tenant context: "AC2 - recipients are validated as emails, and an unknown key is a 400", "AC2 - project_ids that are not readable ...", "AC2 - a day outside the cadence's range ...", "AC2 - a pinned theme that is not this workspace's is refused", "AC2/AC4 - every route needs agency:branding ..." (unit). Integration (run, exit 0): manager is 403, other workspace's project is a 400 and its report is a 404.
3. Delivery uses the EmailSender port with a link to the artifact, recorded 'logged': "AC3 - delivery goes through the EmailSender port ..." (unit). The module provides EMAIL_SENDER via IdentityModule's selectEmailSender (logging adapter by default).
4. Audit row per create, update, delete: @Audit on POST, PATCH, DELETE (and send-now) asserted by the declarations test; row content asserted by integration "AC4 - pause clears next_run_at ..." (run, exit 0).

## Gates (75b4e8b plus the integration spec)

lint exit 0; typecheck exit 0; contracts:generate wrote openapi.generated.json, contracts:check exit 0; contracts:diff against the base: `minor` (new routes only); test:unit exit 0 (280 files, 3352 tests, 1 skipped). test:integration scheduled-reports-http exit 0 (8 tests); test:isolation not run (known fixture crash at this tip; isolation proved under nominara_app in the integration spec). Full test:integration suite is left to the merge step.

## Decisions and gaps to know

- The artifact link in the email is `https://app.nominara.com/report-artifacts/<id>`: no route serves it yet (artifacts are inline `data:` URLs this week; the signed download link is scenario 11, not this story). The logging transport sends nothing anyway.
- brand theme pinned by `theme_id` is stored and validated, but ExportService still draws with the workspace default theme; honouring the pinned theme needs an ExportService change outside this story's notes.
- next_send_at is computed on create/update; nothing fires it yet (the `report.build` runner and the fortnight spacing for biweekly are not in this story). Send-now does not move next_send_at.
- A cap skip is a 200 with a skipped_cap delivery; no-allowance is the 403 and writes no delivery (the response is the refusal). Reservation uses jobId `scheduled-report:<delivery id>`.
- Frontend (lib/api/reports.ts moves to the generated client) is not in this lane's repo.
- Evidence that needs a running real API is collected in NEW-A-17.
