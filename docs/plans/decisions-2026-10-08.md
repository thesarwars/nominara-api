# Owner decisions, 2026-10-08 (after the days 5-6 build)

Owner-approved:
1. NEW-B-5 ownership transfer: DEFERRED to week 2.
2. GET /v1/workspaces/{id}/summary data_source live|demo -> live|demo|mixed|null: APPROVED breaking change; record it in contracts/baseline/breaking-changes.json.
3. NEW-A-13 scheduler: Option A. The sweep claims due projects (FOR UPDATE SKIP LOCKED) and enqueues one signed job per project with dedup key run:{project}:{next_run_at}; only the capture.plan handler advances next_run_at. In-process runtime in the capture worker, hourly at :05 UTC. Reword AC2 accordingly.
4. NEW-D-7 auto-top-up: triggered via a new billing.auto_topup queue (signed tenant job), never on the request path. Save the card for off-session use only when the workspace has auto-top-up enabled.

Lead's calls (planner/agent recommendations accepted):
- NEW-A-5 blend: all measured engines, demo count disclosed (policy all_measured_engines).
- Goals (STORY-065-A): only engine_score and topic_authority creatable this week.
- API keys: new keys read-only by default (no permission picker this week).
- Command parse costs 0 credits (grammar + cache only; model parse is not built).
- STORY-085 #11: the only row a parse writes is the outcome-only audit row.
- NEW-C-5 dismiss/restore permission: task:create.
- NEW-C-6: Track B exports a shared task-insert method on TasksService (option 1); fingerprint sha256('authority:{project_id}:{domain}').
- NEW-C-10: add nullable aux_findings.wont_fix_at (lane migration range).
- NEW-C-11: the agent's attribute mapping and coverage definition are accepted; Gemini is excluded from attribute scoring.
- NEW-C-13 lever ranking: severity, then evidence_cells, then slug.
- NEW-C-15: source.verify_presence is enqueued after rollup.metric_daily.
- STORY-056: topic rank 1 for every prompt; presence_lost uses the 1.00 penalty.
- STORY-076b: POST quantity ADDS to the held quantity; annual add-ons return 409 until week 2; GET /billing/addons also lists the purchasable catalog with prices.
- Billing migrations 0074/0075/0077 and d-admin 0085 (UPDATE narrowed to revoked_at) are accepted. A dedicated ops role for support_grants INSERT is week 2.
- ADR-0002: nominara_share_lookup is NOBYPASSRLS, with one role-targeted SELECT policy. This is stricter than the original decision; accepted.
- Portal hide_costs: drop sample_size from the footer when costs are hidden.
- NEW-E-100a: engine_data_sources may be read from answer_captures (the rollup has no such column); not a failure.
- realtime task.created/task.moved title leak to scoped members: send only ids in the event, and let clients refetch.

## Second list, relayed 2026-10-08 (labels R1..R9; the numbers 1..4 above are a different list)

Provenance: this list reached the lane as the "NEW (2026-10-08)" block of the workflow task text, headed "OWNER
DECISIONS (approved)". It is recorded here as relayed, not as an owner-signed quote; if the owner words any of it
differently, edit this file and the citations (they use R<n>). Audit finding: these were cited as "owner decision 3"
and "owner decision 5", which collided with items 3 and 5 of the first list.

### R1
Share-link lookup before the workspace is known: ONE narrow SECURITY DEFINER function that looks up a single share token by its hash and returns only that row, owned by a dedicated role (not a superuser, not the app role), search_path pinned, EXECUTE granted only to the runtime role; auditor-reviewed.
### R2
NEW-B-4 fingerprint is DEFERRED to week 2; do not build it.
### R3
Tracing: metrics and redacted log lines now; OpenTelemetry spans are DEFERRED to week 2. A missing span is not a failed criterion this week; say so in evidence.
### R4
PDFs bundle the Inter font (OFL; add the .ttf files and the licence under the API, embed with pdfkit); per-theme fonts later.
### R5
contracts:diff: an ADDED OPTIONAL field is MINOR at ANY depth (top level included); one rule. This rewrites the "patch for additive fields" wording of STORY-023 AC5 and NFR-REPO-02; the edited text is carried in docs/plans/docs-carry/.
### R6
Portal session rate limit stays literal (10/hour, burst 2).
### R7
GEO: prompts with a null stability_score are excluded and counted.
### R8
Competitor removal gets its own milestone kind 'competitor_removed' (new migration).
### R9
Unverified domains keep NULL coverage.

## NEW-A-5 AC3 (O1 blend policy)

Policy: all measured engines in the blend, demo count disclosed (policy all_measured_engines). Accepted as a lead's
call in the list above; the plan (track-plans.json O1) is annotated to match. The vocabulary half of O1 is the
one data_source vocabulary 'live' | 'demo' | 'mixed' | null, approved in the task text.
