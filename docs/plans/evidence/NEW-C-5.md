# NEW-C-5 — displacement feed read, dismiss and restore (FR-CO-04; STORY-092 AC 7, 9, 15)

Branch 7day/c-comp-3. Commits: contract 99c18c8 · RED 7deea40 · implementation dbe1576. Migration **0099_displacement_dismissal** (range 0098-0099;
the plan's "0030" number is superseded by this lane's range). Spans DEFERRED to week 2 (decision R3); metrics and a redacted log line are in.

## STATUS: DONE (isolation suite excepted) — container-backed proofs run 2026-10-08 after disk recovered to 18 GiB
The earlier "NOT RUN" notes below are superseded by this block. With DOCKER_HOST/TESTCONTAINERS_RYUK_DISABLED set (README, colima):
- `pnpm exec vitest run --config vitest.integration.config.ts test/integration/displacement-feed.spec.ts` -> **exit 0, 17 passed (17)** (the 18 quoted below was a miscount; the file has 17 tests).
- Against a scratch pgvector container I started and removed (port 55498, not 55432): `db:migrate` 0 (0099 applied) · `db:schema-generate -- --check` 0 (80 tables match, so the hand-written columns equal the generator output)
  · `db:schema-check` 0 · `db:rls-generate -- --check` 0 · `db:rls-check` 0 · `db:drift-check` 0 · `db:rollback` 0 (rolled back 0099) · `db:migrate` 0 (re-applied) · `db:schema-check` 0.
- Still NOT run: `test:isolation` (crashes in fixture setup at this tip, d-admin lane; the merge step runs it). Tenant isolation is proven in the integration spec under SET ROLE nominara_app (AC5 tests).
- The integration RED was never observed failing (written and committed with the unit RED); only the unit RED (exit 1, 10 failed) was.

## Acceptance criteria (track-plans.json)

1. **Contract first** — `contracts/analytics/displacement-response.schema.ts` (commit 99c18c8, own commit, `.strict()`): `takers` (from `displaced_by`), `citation_gap` as
   `{url, domain, source_class, held_by, brand_present}`, `recovery_task_count`, `data_source` (live|demo|mixed|null), non-null `before_result_id`/`after_result_id`.
   Proof: `src/modules/displacement/displacement.spec.ts` "NEW-C-5 · contract (AC1)" (5 tests); `src/lib/analytics/displacement-recovery.spec.ts` (5 tests: seedable only,
   concept + authority, empty = 0 not null, case-insensitive). `recoveryTaskCount` (`src/lib/analytics/displacement-recovery.ts`) is the function NEW-C-6 must call so the count and the plan agree.
   DB-backed (not run): integration "NEW-C-5 AC1 — takers, citation_gap and recovery_task_count", "...a seedable domain of ANOTHER workspace does not count", "...data_source".
2. **Order, filters, recovered, dismissed** — integration (NOT RUN): "STORY-092 #7 — ordered by impact_score descending, engine and kind filters", "STORY-092 #7 — paging by (impact_score, id)",
   "STORY-092 #8 — a recovered loss is included and marked with recovered_at", "NEW-C-5 AC2 — dismissed rows are left out unless include_dismissed=true", "NEW-C-5 AC1 — a row whose
   before or after capture is not stored does not render". Unit (run): "AC2 — the query is strict, include_dismissed defaults to false, kind is the DB vocabulary".
   The SQL: `ORDER BY impact_score DESC, id DESC`, INNER JOIN on both captures, cursor key `(impact_score::text, id)` (a float cannot be a cursor element).
3. **Dismiss and restore, reversible, audited, restore of a non-dismissed row = 409** — unit (run): "AC3 — restoring a row that is not dismissed is 409, and nothing is written",
   "AC3 — dismiss stamps dismissed_at and the actor; restore clears both", "AC3 — dismissing an already-dismissed row is a no-op", route wiring tests assert `@Audit`
   (`displacement.dismissed` / `displacement.restored`). Integration (NOT RUN): "STORY-092 #15", "AC3 — restoring ... 409", "dismissing twice", "concurrent restores: exactly one succeeds".
   Dismiss is idempotent (200, first timestamp kept); restore is the only 409, as the plan says.
4. **Permissions** — GET `tracking:read` + `@ProjectParam("id")`; dismiss and restore `task:create` (PROPOSED; the spec names none) + `@ScopedByQuery()` with the scope checked in the
   service (403 outside it, never 404). Proof: "NEW-C-5 · route wiring (AC4)" (3 tests) and "AC4 — a row ... outside the caller's project scope is a 403". **Owner sign-off needed on `task:create`
   and on the restore endpoint existing at all** (it is in neither the spec nor the frontend).
5. **Tenancy** — unit: "AC5 — an id RLS hides is 404", "AC5 — a project RLS hides is 404 before any feed query runs". Integration under `SET ROLE nominara_app` (NOT RUN):
   "AC5 — another workspace's displacement id is 404 on dismiss and restore, and the row is untouched", "...another workspace reading this project's feed gets 404".
   `test:isolation` was not run (crashes at this tip in fixture setup, d-admin lane; and disk).

## RED
Commit 7deea40, `pnpm exec vitest run src/modules/displacement src/lib/analytics/displacement-recovery.spec.ts`: **2 files failed, 10 failed / 7 passed, exit 1**
(the recovery spec failed to import the missing module; the service tests failed "service.dismiss/feed is not a function"; the 7 passes were the contract tests over the already-committed schema
and the compile test). The integration spec was committed in the same RED commit but could not be executed. Implementation: 22/22 green on those two files.
One test finder in my own RED (`seen.find(/UPDATE/)` matched `FOR UPDATE`) was corrected to `/^\s*UPDATE/` in the implementation commit; no assertion was relaxed.

## Gates (HEAD dbe1576)
`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test:unit` 0 (278 files passed, 1 skipped; 3334 tests) · `pnpm contracts:generate` then `pnpm contracts:check` 0 ·
`pnpm contracts:diff <HEAD~ openapi> <new>` = **minor** (three new operations: listProjectDisplacements, dismissDisplacement, restoreDisplacement; no existing one changed).
NOT RUN (disk): test:integration for this spec, db:* checks above, test:isolation.

## Observability
Metrics `nominara_displacement_feed_reads_total`, `nominara_displacement_state_changes_total{action}`; log "displacement dismissed|restored" with `workspace_id` and `displacement_id` only.
Verified in the unit test "observability — counts the change and logs workspace and displacement IDs only". OpenTelemetry span: deferred to week 2.

## Evidence that needs a running real API: collected in NEW-A-17
The HTTP-level 403/409/404 envelope for the three routes, and the `audit_log` rows for dismiss/restore written through the real interceptor.

## Not done in this change
- **Frontend** (app-fnt-dev-main, outside this lane's worktree): `Displacement.kind` -> DB vocabulary, `restoreDisplacement()`, Restore control, four async states.
- `recovery_task_count` counts from the gaps alone; it does not drop to 0 once `task_id` is set. NEW-C-6 decides what an existing plan means (its 409).
- Docs to carry to the docs repo: `api-specification.md` §3 needs `POST /displacements/{id}/dismiss` and `/restore` and the `task:create` choice; `schemas/captures-and-facts.md` needs `dismissed_at`, `dismissed_by` on `displacement_events`.
