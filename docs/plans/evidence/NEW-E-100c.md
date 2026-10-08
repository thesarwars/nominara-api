# NEW-E-100c: scheduled reports CRUD, send-now, delivery history, cap skip with explicit notification

Tracing: metrics (`nominara_reports_scheduled_deliveries_total{status}`, `nominara_reports_scheduled_changes_total{event}`) and redacted log lines (workspace ID and scheduled-report ID only, no label, recipients or figures) this week; OpenTelemetry spans deferred to week 2 (owner decision 3).
Commits: contract 1c1c7bd (send-now response = the delivery attempt), RED 1a60a6f, implementation 75b4e8b, integration spec (see below).
RED 1a60a6f, run: `vitest run test/unit/reports/next-send-at.spec.ts src/modules/reports/scheduled-reports.spec.ts` exit 1, 2 files failed, 0 tests ran, reason "Cannot find module" (next-send-at.ts, scheduled-reports.controller/service absent). After implementation: 15 + 13 tests pass. One assertion in the s10 test was corrected after implementation (the notification kind is a SQL literal, so the check reads the statement text as well as the params); no threshold or expectation was relaxed.

## Integration spec was NOT run

test/integration/scheduled-reports-http.spec.ts is written, typechecks and lints, but was not executed: `df -h /System/Volumes/Data` showed 7.4 GiB then 6.6 GiB free, under the 8 GiB testcontainers floor, so I stopped rather than start containers. It must be run at merge. No RED run exists for it. Tenant isolation is asserted in it under the app role (test "RLS"), not through test:isolation. No tenant table or migration was touched (migrations: none; scheduled_report_deliveries is NEW-E-1's).

## Acceptance criteria

1. RED tests first for scenarios 7, 8, 9, 10, 15; send-now at the cap writes skipped_cap + a notification naming cap and reset date; every attempt listed with outcome and reason:
   - s7: test/unit/reports/next-send-at.spec.ts (weekly, biweekly, monthly, quarterly, workspace-local hour in Dhaka/Kolkata/New York/Auckland, DST gap and overlap, strictly-after, range refusal). Exit 0, 15 tests.
   - s8: src/modules/reports/scheduled-reports.spec.ts "s8 - a run costs zero credits and consumes ONE pdf_exports unit ..." and "s8 - a csv-only report consumes no pdf unit". HTTP: integration "s8/s15 - send-now: zero credits, ONE pdf unit for two projects ..." (not run).
   - s9: "s9 - a tier with ZERO allowance is 403 feature_not_in_plan ..." (unit); integration "s9 ..." (not run).
   - s10: "s10 - at the cap the run is skipped ..." (unit: delivery status, reason with cap and reset date, notification kind/body, nothing built or sent, no commit); integration "s10 ..." (not run).
   - s15: "s15 - list() returns every attempt with its outcome and failure reason" and "s15 - a failed build is listed as 'failed' with its reason, the reservation is released ..." (unit).
2. Permission agency:branding; recipients validated as emails; project_ids readable in the tenant context: "AC2 - recipients are validated as emails, and an unknown key is a 400", "AC2 - project_ids that are not readable ...", "AC2 - a day outside the cadence's range ...", "AC2 - a pinned theme that is not this workspace's is refused", "AC2/AC4 - every route needs agency:branding ..." (unit). Integration (not run): manager is 403, other workspace's project is a 400 and its report is a 404.
3. Delivery uses the EmailSender port with a link to the artifact, recorded 'logged': "AC3 - delivery goes through the EmailSender port ..." (unit). The module provides EMAIL_SENDER via IdentityModule's selectEmailSender (logging adapter by default).
4. Audit row per create, update, delete: @Audit on POST, PATCH, DELETE (and send-now) asserted by the declarations test; row content asserted by integration "AC4 - pause clears next_run_at ..." (not run).

## Gates (75b4e8b plus the integration spec)

lint exit 0; typecheck exit 0; contracts:generate wrote openapi.generated.json, contracts:check exit 0; contracts:diff against the base: `minor` (new routes only); test:unit exit 0 (280 files, 3352 tests, 1 skipped). test:integration, test:isolation: not run (disk, see above).

## Decisions and gaps to know

- The artifact link in the email is `https://app.nominara.com/report-artifacts/<id>`: no route serves it yet (artifacts are inline `data:` URLs this week; the signed download link is scenario 11, not this story). The logging transport sends nothing anyway.
- brand theme pinned by `theme_id` is stored and validated, but ExportService still draws with the workspace default theme; honouring the pinned theme needs an ExportService change outside this story's notes.
- next_send_at is computed on create/update; nothing fires it yet (the `report.build` runner and the fortnight spacing for biweekly are not in this story). Send-now does not move next_send_at.
- A cap skip is a 200 with a skipped_cap delivery; no-allowance is the 403 and writes no delivery (the response is the refusal). Reservation uses jobId `scheduled-report:<delivery id>`.
- Frontend (lib/api/reports.ts moves to the generated client) is not in this lane's repo.
- Evidence that needs a running real API is collected in NEW-A-17.
