# NEW-C-10 — AUX reads and finding actions (STORY-052; api-specification.md "AUX")

Lane 7day/c-src-3, base integration/7day 328ec2e.
Commits: contract a19c15a, RED 161d314, implementation cd42f2d.

Status: PARTIAL by design. create-task is blocked (below); the 180-day will-not-fix re-surface needs a decision (below). Everything else is built.

## RED
161d314: `pnpm vitest run src/modules/aux` exit 1, 26 failed | 5 passed (31). Reason: `service.updateFinding / getAudit / listProject* is not a function`
(the 5 passing are the module-compiles test and 4 contract-schema tests that depend only on the contract commit). The real-SQL spec
test/integration/aux-reads-and-actions.spec.ts was committed in the same RED commit; it could not be run before implementation (it imports
methods that did not exist), so its RED is the same missing-method reason.

## Criteria
| Criterion | Proof | Result |
|---|---|---|
| AC1 Contract first: contracts/aux/*.schema.ts | a19c15a (aux-audit.schema.ts, aux-finding.schema.ts) precedes the handler; PATCH body and every query are .strict() ("[NEW-C-10 AC1] the PATCH body is strict") | met |
| AC2 PATCH acknowledged | aux.spec.ts "[NEW-C-10 AC2] acknowledged from open or regressed writes the status"; integration "acknowledged -> open round-trips" | met |
| AC2 open from acknowledged only | aux.spec.ts "[NEW-C-10 AC2] open is accepted from acknowledged only" (409 from open, in_progress, regressed, wont_fix, stale, resolved, no write); integration same | met |
| AC2 wont_fix with a required reason | aux.spec.ts "wont_fix without a reason is refused" (contract), "wont_fix stores the reason; from a resolved or stale finding it is a 409"; integration "wont_fix stores the reason and annotates the read" | met |
| AC2 wont_fix annotation visible | finding.wont_fix = {reason}; aux.spec.ts "a wont_fix finding carries its reason as a visible annotation" | met |
| AC2 wont_fix resurfaces after 180 days | NOT MET this week. No column records when a finding was set will-not-fix (aux_findings has no wont_fix_at; updated_at moves on every re-detection by the crawl.audit handler, so it cannot be used). A column is a schema change the story does not name. DECISION NEEDED: add nullable wont_fix_at timestamptz to aux_findings (migration in range 0100-0101) and set it in PATCH; the response then gains resurfaces_at (an added optional field, MINOR). The crawl.audit handler's re-surface action is STORY-052, not this item. | open question |
| AC2 'resolved' returns 422 (assert it) | aux.spec.ts "[NEW-C-10 AC2] resolved is a 422 and writes nothing" (all 7 starting states, zero UPDATEs); integration "resolved is a 422 and the row is untouched" (real row unchanged). Mutation: guard removed, that test fails (1 failed, 30 passed, exit 1) | met |
| AC2 no client path sets resolved | aux.spec.ts "the controller has exactly the four reads/actions" and "the only UPDATE is on status and wont_fix_reason: no resolved_at, no severity, no fingerprint" | met |
| AC3 aux:read for reads | aux.spec.ts "[NEW-C-10 AC3] reads require aux:read" (controller metadata, 3 routes) | met |
| AC3 task:create for PATCH, with @Audit | aux.spec.ts "[NEW-C-10 AC3] PATCH requires task:create and is audited" (action aux_finding.updated) | met |
| AC3 create-task permission, @Audit, 409 with existing task_id on a second call | NOT BUILT: blocked, see below | blocked |
| AC4 Works for demo-seeded and real site-file audits and findings | aux.spec.ts: "maps a demo-seeded audit", "a real site-file audit: aux_score null stays null...", "maps a demo-seeded finding", "a real site-file finding keeps its evidence"; integration "an audit with no score reads aux_score null and delta null". The finding evidence contract is a union of the site-file shape and the demo {selector,snippet,measured,expected} shape. Against the demo seed itself, collected in NEW-A-17 (needs the real API). | met in tests; real-API run in NEW-A-17 |
| AC4 GET /projects/{id}/aux-audits?limit=1 | aux.spec.ts "?limit=1 returns the newest audit first and says whether there are more"; integration "reads the latest audit first with ?limit=1, delta against the previous scored audit" | met |
| GET /aux-audits/{id}, GET /projects/{id}/aux-findings with severity/status/rule/URL filters and keyset paging | aux.spec.ts "filters ... as bound parameters"; integration "filters findings by status, rule and URL, and pages by cursor without skipping" | met |
| null versus 0 | aux_score null stays null, "0.000" reads 0, delta 0, measured_value "0" reads 0 vs null, llms_txt_present/sitemap_url_count null vs false/0 (aux.spec.ts, 3 tests) | met |
| Tenant isolation / RLS | integration, as nominara_app: "another workspace's audit and finding are invisible: 404, and a PATCH changes nothing"; "a scoped caller cannot PATCH or read ... out-of-scope project" (403). Both queries carry no workspace_id predicate (aux.spec.ts asserts it) | met |
| Concurrency | the PATCH locks the row FOR UPDATE (aux.spec.ts "locks the row so two concurrent PATCHes serialise"); no two-connection race test was written | partial |

## create-task: BLOCKED
POST /aux-findings/{id}/create-task is not built, and no route, schema or stub exists for it. It needs the Track B task-insert helper (a finding-sourced
task insert with dedupe fingerprint, short_ref and the task_events row). TasksService has only the manual createTask; writing a second task-insert path
here is what the plan forbids. Needed: Track B lands that helper; then add the route (task:create, @Audit, Idempotency-Key), the 409 carrying the
existing task_id, and the finding's `task_id` (already read from tasks.source_finding_id) is in place for it.

## Frontend (not done in this lane)
The lane is the api worktree; pending.ts is in the client repo. The contract differs from pending.ts AuxAudit as the story says: scope is the five DB values,
status adds queued and partial, `manual_price`, `credits_charged`, `next_scheduled_at`, `uncapped_score` and `passed` are not in the contract (the priced
POST is deferred, so the manual re-audit button keeps its pending state), `capped` and `excluded_rules[{rule_code,title}]` are. AuxFinding.wont_fix has no
resurfaces_at until the decision above.

## Reference gap
GET /projects/{id}/aux-audits is not in api-specification.md (the plan says so). Carry to the docs repo: add the row, aux:read, "newest first, ?limit=1 is the latest".

## Observability
Metrics: nominara_aux_audit_reads_total{route}, nominara_aux_finding_reads_total{filtered}, nominara_aux_finding_actions_total{action,outcome}.
Log line "aux finding updated" carries workspace_id, finding_id and the from/to states only, never the reason. Verified in the integration run output (metric and log lines
printed). OpenTelemetry spans are deferred to week 2 by owner decision; a missing span is not a failed criterion this week.

## Gates (api-wt-c2)
- pnpm lint: exit 0
- pnpm typecheck: exit 0
- pnpm test:unit: exit 0, 278 files passed | 1 skipped, 3345 tests passed | 1 skipped
- pnpm vitest run --config vitest.integration.config.ts test/integration/aux-reads-and-actions.spec.ts: exit 0, 8 passed (8), real Postgres 18 (testcontainers), disk 9.3 GiB free at run time
- pnpm contracts:generate then contracts:check: exit 0, no drift; contracts:diff against the base openapi: "minor" (new paths only)
- test:isolation: not run (known fixture crash at this tip; the merge step runs it). Tenant isolation is proven in the integration spec under nominara_app.
- No migration, no schema change, no new dependency.
- Mutation: resolved guard removed -> 1 failed (exit 1); open-from-acknowledged-only relaxed -> 1 failed (exit 1); both restored.

## Checkpoint-3 fix: the 180-day re-surface (branch 7day/c-src-4)

Decision applied: "NEW-C-10: add nullable aux_findings.wont_fix_at (lane migration range)" (decisions-2026-10-08.md). Commits: contract 731a9ec, RED e8060ac, implementation 56fde7a.

RED e8060ac: `pnpm vitest run src/modules/aux` exit 1, 5 failed | 30 passed (35). Reason: the read had no `resurfaces_at` (`{ reason }` only), the PATCH UPDATE did not mention `wont_fix_at`. The two integration tests added in the same commit run against the real column, which did not exist (not separately run before the migration).

| Criterion | Proof |
|---|---|
| AC1 contract first | 731a9ec: `contracts/aux/aux-finding.schema.ts` `wont_fix.resurfaces_at` is `string().nullable().optional()`; `contracts:check` exit 0; `contracts:diff` against integration/7day's openapi = **minor** (added optional field, decision R5) |
| AC2 wont_fix resurfaces after 180 days | aux.spec.ts "[NEW-C-10 AC2] a wont_fix finding resurfaces 180 days after wont_fix_at, to the millisecond" (2026-10-01T08:30:00.123Z -> 2027-03-30T08:30:00.123Z); integration "wont_fix records wont_fix_at and the read resurfaces it exactly 180 days later; a fresh finding has none" |
| Old rows (set before the column) | aux.spec.ts "a finding set will-not-fix before wont_fix_at existed reports resurfaces_at null, not a guess" (null, never 0 or a fabricated date) |
| Stamp is the DB clock, never a client date | aux.spec.ts "the PATCH stamps wont_fix_at from the database clock ... no client-supplied date" (`wont_fix_at = CASE WHEN $2 = 'wont_fix' THEN now() ELSE NULL END`, no Date param) |
| Re-detection does not move it; non-wont_fix has none | integration "a re-detection by the crawler does not move wont_fix_at, and acknowledging records none"; aux.spec.ts "a finding that is not wont_fix carries no wont_fix annotation even if a stale wont_fix_at is present" |
| Migration | `0118_aux_findings_wont_fix_at.{up,down}.sql`, expand phase, nullable column, no default/backfill. `src/db/schema/aux.ts` regenerated by `db:schema-generate` (output identical to the one-line change); `db:schema-check`, `db:rls-generate --check`, `db:rls-check`, `db:drift-check` all pass (run against a throwaway pgvector container on port 55499, removed afterwards; DB 55432 untouched). `test/integration/migrations.spec.ts` (up, rollbackAll, up): exit 0, 21 passed |

Test changes forced by the contract (not weakened): the two existing `wont_fix` toEqual assertions now include `resurfaces_at: null` (their fixture row has no wont_fix_at); the "only UPDATE" guard now names `wont_fix_at` in its title and still forbids resolved_at, severity, fingerprint, first_detected_at; the integration `toEqual({ reason })` became `toMatchObject({ reason })` because the new test pins `resurfaces_at` exactly.

NOT built (outside this item): the automatic review transition when a later audit re-detects a finding whose `wont_fix_at + 180 days` has passed. That is the crawl.audit handler / `reconcileFindings` lifecycle (STORY-052, NEW-C-9), a pure function with no clock input today. This item records the date and exposes it so the transition can be built; say if it should be added to this lane. create-task is still blocked on the Track B insert helper (unchanged).

Observability: existing `nominara_aux_finding_actions_total{action,outcome}` and the `aux finding updated` log line (workspace and finding IDs, states, never the reason) cover the PATCH; unchanged. Span deferred (R3).

Gates: lint 0, typecheck 0, test:unit 0 (3703 passed), integration (aux-reads-and-actions, rendering-quality, source-presence-verify, seed-demo) exit 0 76 passed, migrations.spec exit 0. `test:isolation`: 12 files passed, 1 failed (ISO-14, see below) -- not this item.

ISO-14 (`test/isolation/namespacing.spec.ts`, "scanner ... finds no un-namespaced prefix in src/"): fails on `src/modules/reports/scheduled-reports.service.ts:234`, a file this lane did not touch. Proven pre-existing: the same spec on detached `fee788e` fails identically (1 failed, 2 passed). Belongs to the e-reports lane.
