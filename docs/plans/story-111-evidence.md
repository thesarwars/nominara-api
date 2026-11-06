# STORY-111 - subject requests, retention automation, residency audit: evidence and open items

Branch `story/111-subject-requests`, migration `0165_legal_holds_purge_runs`. The docs snapshot is not edited; every change the
snapshot needs is listed under "Doc changes needed" for carrying to the docs repo.

## What was built (code ACs)

| AC | Where | Proof |
|---|---|---|
| Inventory derived from the isolation-policy metadata; unregistered table fails the build | `src/lib/compliance/subject-inventory.ts` (`SUBJECT_INVENTORY` keyed on `TENANT_TABLES`) | `subject-inventory.spec.ts` S2 (a planted table is named and fails); `compliance-retention.spec.ts` S2 (live: no exempt table has a foreign key to `users`; this caught two stale exemptions while writing it) |
| Access export, machine-readable | `processAccessRequest` in `src/lib/compliance/subject-request.ts`, schema `contracts/compliance/subject-export.schema.ts` | `compliance-retention.spec.ts` S1 S6 S7 |
| Every metric carries the six facts | `subjectExportMetricSchema` (all six keys required; `live_capture_ratio` and `data_through` nullable, `value` null when unscored) | S7 and the null path |
| Erasure with its two limits stated | `processErasureRequest` wraps `requestIndividualErasure`; the sole-owner reply adds the transfer path | S5 (blocked, nothing changed), S3 S4 (audit and ledger rows retained, actor pseudonymised) |
| Request traced end to end, actor recorded | audit rows `subject_request.received/processed/completed/blocked/failed` in every workspace of the subject | S5 S6 |
| Minimisation before persistence (excerpt, evidence text) | `src/lib/compliance/minimise.ts`; used at `insertCell`, `seedSharedCache` (`execute-cell.ts`) and the sentiment evidence text (`geo/sentiment.ts`) | `minimise.spec.ts`, `capture-minimisation.spec.ts`, `sentiment-evidence-minimised.spec.ts` (mutation-checked: reverting the wiring fails it) |
| Personal names never indexed or searched | `names-not-indexed.spec.ts` (no trigram/full-text index on content tables, no text-search query over content columns; a planted `ILIKE` over `entity_label` was caught) | S10 |
| Retention enforced by automation | the nightly `retention.purge` job already existed; it now passes a journal and an exporter. Still gated by `RETENTION_PURGE_ENABLED` (see open items) | `retention-purge-handler.spec.ts` |
| Purges idempotent, batched, outcomes recorded | `purge_runs` row per cycle (counts only) | S16 |
| In-flight export locks purge | already met (`withExportLock`) | `retention-cascade.spec.ts` T13 |
| No purge path leaves content behind | `cascadeDeleteWorkspace` now also deletes every table that carries `workspace_id` and that no cascade of foreign keys reaches, discovered from the catalog | S17: every base table searched as text for sentinels and the workspace id; the only database row naming the workspace is the audit-chain tombstone |
| Exactly three record sets survive | audit-log export, financial export, purge journal; `legal_holds` rows are deleted with the tenant | S17, S19 |
| Financial export before the cascade; actor ids pseudonymised | `writeComplianceExports`: random per-export alias (a hash of a surviving id is brute-forceable, see `pseudonymise.ts`) | S18 (export sees the rows; a failing export leaves the workspace intact), S19 |
| Exports carry an expiry | `expires_at` object metadata (7 years) and a retention-class key prefix | S19 |
| Purge journal outside the database, no content | `purge-journal.ts` + `S3JournalStore` (`purge-journal/{env}/...` in the raw bucket, outside every workspace prefix; closed-enum reasons, `.strict()` schema) | `purge-journal.spec.ts` S20 |
| Restore re-applies purges after the snapshot | `reapplyPurgesAfterRestore` (`restore-replay.ts`) | S21 (purge, restore by re-inserting the rows, replay: workspace unreadable; a second replay is a no-op; an older purge is not replayed) |
| Legal hold: two people, reason, expiry, audited; skip and report; auto-release | `legal-hold.ts`, tables `legal_holds`, `purge_runs` | S23 S24, library and database CHECKs |
| Workspace region immutable | already met (`region_immutable`) | `workspace-creation-and-one-owned-invariant.spec.ts` |
| Residency audit: fails loudly on an out-of-region object | `residency-audit.ts` (fail closed: unknown region or unpinned workspace is a violation) | `residency-audit.spec.ts` S26 |
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
