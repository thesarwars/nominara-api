# STORY-111 - subject requests, retention automation, residency audit: evidence and open items

Branch `story/111-subject-requests`, migration `0165_legal_holds_purge_runs`. The docs snapshot is not edited; every change the
snapshot needs is listed under "Doc changes needed" for carrying to the docs repo.

## What was built (code ACs)

| AC | Where | Proof |
|---|---|---|
| Inventory derived from the isolation-policy metadata; unregistered table fails the build | `src/lib/compliance/subject-inventory.ts` (`SUBJECT_INVENTORY` keyed on `TENANT_TABLES`) | `subject-inventory.spec.ts` S2 (a planted table is named and fails); `compliance-retention.spec.ts` S2 (live: no exempt table has a foreign key to `users`; this caught two stale exemptions while writing it) |
| Access export, machine-readable - **PARTIAL (no caller)** | `processAccessRequest` in `src/lib/compliance/subject-request.ts`, schema `contracts/compliance/subject-export.schema.ts`. Default-deny columns (`SUBJECT_INVENTORY[].columns` / `.omit`), other people's user ids exported as null, metrics only for workspaces where the subject is an active member | `compliance-retention.spec.ts` S1 S6 S7 and the round-1 cases below |
| Every metric carries the six facts | `subjectExportMetricSchema` (all six keys required; `live_capture_ratio` and `data_through` nullable, `value` null when unscored) | S7 and the null path |
| Erasure with its two limits stated - **PARTIAL (no caller)** | `processErasureRequest` wraps `requestIndividualErasure`; the sole-owner reply adds the transfer path. Round 1: the address is also removed from `workspace_invitations`, `scheduled_reports.recipients` and `downgrade_notices`; a legal hold on the subject's workspace is REPORTED in the outcome | S5 (blocked, nothing changed), S3 S4 (audit and ledger rows retained, actor pseudonymised) |
| Request traced end to end, actor recorded | audit rows `subject_request.received/processed/completed/blocked/failed` in every workspace of the subject | S5 S6 |
| Minimisation before persistence (excerpt, evidence text) | `src/lib/compliance/minimise.ts`; used at `insertCell`, `seedSharedCache` (`execute-cell.ts`), the sentiment evidence text (`geo/sentiment.ts`) and, since review round 1, the Visibility Scan excerpt (`toEngineResult`, streamed AND stored in `tool_runs.result`) | `minimise.spec.ts`, `capture-minimisation.spec.ts`, `sentiment-evidence-minimised.spec.ts` (mutation-checked: reverting the wiring fails it) |
| Personal names never indexed or searched | `names-not-indexed.spec.ts` (no trigram/full-text index on content tables, no text-search query over content columns; a planted `ILIKE` over `entity_label` was caught) | S10 |
| Retention enforced by automation | the nightly `retention.purge` job already existed; it now passes a journal and an exporter. Still gated by `RETENTION_PURGE_ENABLED` (see open items) | `retention-purge-handler.spec.ts` |
| Purges idempotent, batched, outcomes recorded | `purge_runs` row per cycle (counts only) | S16 |
| In-flight export locks purge | already met (`withExportLock`) | `retention-cascade.spec.ts` T13 |
| No purge path leaves content behind - **PARTIAL** | Database: met. `cascadeDeleteWorkspace` deletes every `workspace_id` table no cascade reaches, and (round 1) `deleteProjectRows` does the same per project (notifications had been left behind by a project purge). Objects: **only the reports bucket** is deleted (`deleteWorkspaceReports`); the raw and crawl prefixes are STORY-182's, so a real workspace purge still leaves its raw answer objects under `{env}/{ws}/` | S17 (workspace; every base table searched as text; the object stub now behaves like production and the test asserts the raw object REMAINS) and S17 project scope. The AC closes when STORY-182 wires the raw and crawl prefix deletes |
| Exactly three record sets survive | audit-log export, financial export, purge journal; `legal_holds` rows are deleted with the tenant | S17, S19 |
| Financial export before the cascade; actor ids pseudonymised | Financial records = `credit_ledger`, `invoices`, `subscriptions`, `subscription_addons`, `credit_purchases` (round 1: invoices and subscription state were being deleted by the cascade with no copy). `writeComplianceExports`: random per-export alias for every person column (`actor_id`, `purchased_by`, `created_by`) | S18 (export sees invoice, purchase, subscription rows; a failing export leaves the workspace intact), S19 |
| Exports carry an expiry | `expires_at` object metadata (7 years) and a retention-class key prefix | S19 |
| Purge journal outside the database, no content | `purge-journal.ts` + `S3JournalStore` (`purge-journal/{env}/...` in the raw bucket, outside every workspace prefix; closed-enum reasons, `.strict()` schema) | `purge-journal.spec.ts` S20 |
| Restore re-applies purges after the snapshot - **PARTIAL (library, no restore procedure calls it)** | `reapplyPurgesAfterRestore` (`restore-replay.ts`); the project replay now runs the same `deleteProjectRows` as the purge | S21 (purge, restore by re-inserting the rows, replay: workspace unreadable; a second replay is a no-op; an older purge is not replayed) |
| Legal hold: two people, reason, expiry, audited; skip and report; auto-release - **PARTIAL (no operator entry point)** | `legal-hold.ts`, tables `legal_holds`, `purge_runs`. Round 1: the purge re-checks the register INSIDE its own transaction under an advisory lock that `placeLegalHold` also takes, so a hold placed mid-cycle protects its subject; cleanup deletes only released or lapsed rows | S23 S24, library and database CHECKs |
| Workspace region immutable | already met (`region_immutable`) | `workspace-creation-and-one-owned-invariant.spec.ts` |
| Residency audit: fails loudly on an out-of-region object - **PARTIAL (core only; no caller, no inventory source)** | `residency-audit.ts` (fail closed: unknown region, unpinned workspace, or an empty inventory while workspaces are pinned) | `residency-audit.spec.ts` S26 |
| No training pipeline; per-vendor opt-out documented | `model-vendors.ts` + `model-vendors.spec.ts` | S27, S28 (every model host in source must be registered) |
| Shared cache: no tenant-derived content | `shared-cache-disclosure.spec.ts`; opt-out `no_shared_cache` is enforced by the planner (already) | S29 |

## Defects found and fixed on the way

1. `executeWorkspaceHardDelete` left `answer_captures`, `mention_facts` and `citation_facts` (no foreign key by design),
   `notifications`, `report_artifacts` and `source_domains` behind after the workspace row was deleted. That is the archive of an erased
   tenant the story forbids. Fixed in `cascadeDeleteWorkspace` by discovering such tables from the catalog (`workspaceTablesWithoutCascade`).
2. The compliance export did not exist as an object-storage write at all (the purge handler passed no exporter, so a workspace hard
   delete could only ever record a failure). `writeComplianceExports` is that writer.

## Not built, and why (open ACs)

- **HTTP access/portability endpoint.** No route is specified in `api-specification.md`; inventing a path and verbs is a specification gap.
  The mechanism is `processAccessRequest` / `processErasureRequest` on the owner connection (retention.ts PRIVILEGE CONTRACT), ready to sit
  behind a route or a CLI once the route is specified. Left open.
- **Stricter access path for the raw object (AC "Raw object ... stricter access path").** Shorter retention exists (`expireRawCaptures`);
  a distinct access path (a separate role or presign policy for raw objects) is a design decision. Left open.
- **Beacon aggregates at ingest.** No beacon code exists in `api/src`; post-launch per product-brief D3. Not built.
- **Lifecycle rule and Object Lock on the exports bucket; the residency inventory source (bucket regions); the schedule for the residency
  audit.** Infrastructure (decision 45: Terraform and observability parked). The code writes the expiry the lifecycle rule keys on and the
  audit core is ready; nothing here pretends the bucket rule exists.
- **Wiring `db:purge-check` into the release pipeline with an alert.** CI is parked (decision 45). The purge cycle now logs an error and
  counts failures (`nominara_retention_purge_cycles_total{status="partial"}`) for the alert to key on.
- **Turning the nightly purge on.** `RETENTION_PURGE_ENABLED` stays off: the object-prefix delete for raw/crawl prefixes (STORY-182) and
  the 14-day downgrade notice (STORY-077 R1) are not part of this story, and the project purge still needs `deleteObjectPrefix`.
- **Privacy notice, backup-window disclosure, subprocessor list, breach-notification text, DPA clause for the shared cache.** Legal text,
  owned by the owner; the privacy notice and subprocessor list live in nominara-web. Suggested wording for the backup window is below.
- **Vendor training opt-out confirmations.** The registry records every model host as `pending_owner_confirmation`; code cannot see the
  vendor account. Needs the owner (Google, OpenRouter, OpenAI account settings or contract references).

## Findings the owner should rule on

- `answer_captures.payload` holds the verbatim answer text and has a GIN `jsonb_path_ops` index (`ix_results_payload`, migration 0003).
  `jsonb_path_ops` supports containment of whole values only, so it is not a substring or name search, and no code uses `@>` on it; but it
  is an index over a column holding verbatim text. Dropping it is a schema change this story did not name. Recommend a one-line story.
- A project-level legal hold skips the whole workspace's nightly retention sweep (over-retains). The expiry functions are workspace-scoped;
  per-project exemption would need project-scoped variants of each. Safe side chosen; say if you want the finer grain.
- The first-ever purge journal and export writes need the raw bucket to allow `purge-journal/` and `compliance-exports/` top-level
  prefixes (they sit outside `{env}/{workspace}/`).

## Doc changes needed (docs snapshot, not edited here)

- `stories/launch/STORY-111-...md`: status check for this build (ACs above); the endpoint, raw-access-path, beacon and infrastructure items stay open.
- `references/data-model.md` section 7: workspace hard delete also removes every `workspace_id` table that no foreign key cascades into;
  record the new global tables `legal_holds` and `purge_runs` (owner-only, no runtime grant) and the table census (89 / 67 tenant / 22 global).
- `references/api-specification.md`: the subject-request route is unspecified.
- Privacy notice text suggestion (nominara-web), backup window: "Backups are kept for 35 days. When we delete your data, it is removed from
  live systems at once and from backups when those backups expire, up to 35 days later. We do not edit a backup, because an edited backup
  can no longer be used to recover the service."
- Breach notification: processor notifies controllers within 24 hours of confirmation, with the facts known at that time rather than
  waiting for completeness (NFR-CMP-15).

## Review round 1 (head 7f51b00b) - what changed

- **Legal hold race (major).** `cascadeDeleteWorkspace` and `hardDeleteProject` (owner path, `holdCheckAt`) take `pg_advisory_xact_lock('legal-hold:'||workspace)` and re-read the register inside the purge transaction; `placeLegalHold` takes the same lock and re-resolves the subject under it. A held subject is skipped and reported (`held`), nothing is exported-and-deleted, and the cleanup deletes only `released_at IS NOT NULL OR expires_at <= now()`. Tests: S23 RACE (project, workspace; a hook between the read and the purge places the hold; data AND hold survive), released-row cleanup. Mutation: removing the in-transaction check fails both RACE tests. One residual: for a workspace the export is written before the cascade's check, so a hold that wins the race leaves an export of a workspace that was not purged (a copy, not a deletion).
- **Access export default-deny (major).** `SUBJECT_INVENTORY` carries `columns` (exportable) and `omit` per exported table; the export reads only `columns`; the integration test fails on any live column in neither list, the unit test fails on a credential-looking column in `columns`. `gsc_connections.credentials_enc/refresh_enc` and `attribution_configs.ga4_credentials_enc` are omitted by name (test seeds both and greps the output).
- **Third-party data in the export (major).** Rows are selected by the columns that make the subject the data subject (`workspace_members.user_id`, not `invited_by`); `workspace_invitations.email`, `workspaces.billing_email/dsar_contact_email/ownership_transfer`, `scheduled_reports.recipients` and the audit `before_state/after_state` are omitted; every other user id in an exported row that is not the subject's is null. Test: U invites V, V's email, id and name are absent. **Owner decision wanted:** omitting audit `before_state/after_state` removes detail of the subject's own actions; the alternative is a per-action redaction pass.
- **Removed member's metrics (major).** Metrics are read only for workspaces where the subject is an active member.
- **Erasure completeness (major).** See the erasure row above. S3/S4 sweep: after erasure, no base table except `audit_log` and `credit_ledger` (pseudonymised sets) holds the address or the name. Not covered: `workspaces.billing_email` / `dsar_contact_email` when they equal the subject's address (a workspace contact, not the person's record; a sole owner is blocked from erasure, a non-owner is rarely the contact) - say if you want them scrubbed too.
- **Project purge leaves notifications (major).** `projectTablesWithoutCascade` + `deleteProjectRows`; `credit_ledger`, `usage_ledger`, `audit_log` are deliberately retained.
- **Scan excerpt (major).** `toEngineResult` uses `minimiseExcerpt`. Every other place an engine answer's text is written or streamed: `answer_captures.response_excerpt` and the shared-cache excerpt (`execute-cell.ts`, minimised), `answer_captures.payload` and the raw object (VERBATIM by design: the raw record the story keeps), sentiment evidence text (`geo/sentiment.ts`, minimised), the L1 envelope `payload` (verbatim, same reason), `tool_runs.result_json` via the scan result (now minimised). No other jsonb/stream write of answer text exists in `src`.
- **S17 stub (major).** Production-faithful; see the "No purge path" row. This AC is PARTIAL until STORY-182.
- **Financial export (major).** See the row above.
- **Minors.** Post-erasure audit rows use the system actor (null id), not `SYSTEM_ACTOR_ID` as a `user`; a subject with no membership has no workspace chain, so the request is traced by `request_id` in a redacted log line (`subject_request`) and the counter. `names-not-indexed` detectors moved to `names-not-indexed.ts` and the planted cases run through them. A journal failure on the objects-left-behind path is counted as its own failure. Stale file names in comments fixed.

## Accepted, documented, or for the owner

- **Crash window (accepted).** The journal entry is appended after the cascade commits; a kill between the commit and the append leaves a purge with no entry and no `purge_failures` row, and a restore older than it would bring the workspace back unnoticed. Journalling first would purge a live tenant on a restore of a purge that rolled back. A two-phase entry (`pending`, then `confirmed`, replay only confirmed-or-pending-and-absent) would close it; not built. Owner: accept or ask for the two-phase entry.
- **Buckets (owner/infra with STORY-003).** The journal (`purge-journal/`) and the 7-year exports (`compliance-exports/`) go in the `raw` bucket, which will get a short raw-capture lifecycle expiry, and the audit export must be Object Lock (compliance mode). Either a separate compliance bucket with its own lifecycle, or prefix-scoped rules that exclude those two prefixes. Until then nothing expires them (the lifecycle rules do not exist yet), but STORY-003 must not add a bucket-wide expiry. The same decision covers region pinning for these objects (see `residency-audit.ts`).
- **Legal hold vs individual erasure (owner).** Erasure pseudonymises audit-log actor ids in a held workspace, which alters evidence under preservation. It is not blocked (an erasure request has its own statutory clock); it is reported in the outcome (`heldWorkspaces`) and in the audit row. Decide: block, defer, or proceed-and-report.
- **Operator entry points.** Nothing calls `processAccessRequest`, `processErasureRequest`, `placeLegalHold`, `releaseLegalHold`, `auditResidency` or `reapplyPurgesAfterRestore`. They are tested libraries on the owner connection. Thin CLIs (`db:legal-hold:place`, `db:subject-request`, `db:restore:replay-purges`, the last refusing exit 0 when `failed` is non-empty) are the next step and need `package.json` scripts, which this story's notes do not name; raise as a story.
- **Review route.** This change touches tenant context and owner-connection cross-tenant deletes, the credit-ledger export, the audit chain and the capture excerpt path: `dangerous-area-auditor` must review it as the second engineer before merge.

## Doc changes needed (round 1 additions)

- `data-model.md` section 7: financial records export = ledger, invoices, subscriptions, add-ons, credit purchases; legal-hold check is inside the purge transaction; project purge also removes `project_id` tables no cascade reaches; the journal/exports bucket decision.
- `STORY-111`: AC statuses as above (Partial: access/erasure/hold/restore/residency have no operator entry point; "no content left behind" blocked on STORY-182 for objects).
