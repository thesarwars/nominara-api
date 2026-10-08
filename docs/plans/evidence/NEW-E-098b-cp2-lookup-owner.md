# NEW-E-098b / CP2 owner decision 1 — evidence

Item: rebuild `app.share_token_by_hash` (migration 0080) as the narrow SECURITY DEFINER lookup owned by a dedicated
role. Branch `7day/e-portal-3`. Migration 0112. ADR-0002.

Commits: RED `b4adb26` (7 integration tests; 5 failed, exit 1), RED `00686ab` (DEF-8/9 and unit DEF-U1..3; integration
6 of 9 failed, unit 2 of 3 failed, exit 1), GREEN `13d71c8`.

## Decision vs. the spec (needs the owner's eye)

The decision says "dedicated role, not a superuser, not the app role". It does not say BYPASSRLS. `ISO-07`
(security-and-tenancy.md) and the accepted ADR-0001 reserve `rolbypassrls` for `nominara_breakglass` alone, and ADR-0001
explicitly rejected a BYPASSRLS definer. So the role is NOBYPASSRLS and reads `share_tokens` through one role-targeted
`FOR SELECT TO nominara_share_lookup USING (true)` policy. That adds a second policy class on one table, which is why
ADR-0002 exists (Status: Proposed, pending the auditor). If the owner prefers BYPASSRLS, ISO-07, ADR-0001 and
`database-roles-and-grants.spec.ts` scenario 1 must be amended first; I did not do that.

## Criteria

| Criterion | Proof | Result |
|---|---|---|
| Narrow SECURITY DEFINER lookup by hash, returns only that row | `test/integration/share-token-lookup-definer.spec.ts` "DEF-3 ..." (three workspaces' tokens present; hash A returns only A, B only B, unknown/empty/NULL return 0 rows; no token_hash/label/prefix/creator column). Also `share-token-gate-rls.spec.ts` "STORY-098 s5 ..." (2 tests) | pass |
| Owned by a dedicated role, not a superuser, not the app role, not the migration identity | "DEF-1" (owner = nominara_share_lookup; NOLOGIN, NOSUPERUSER, NOINHERIT, NOCREATEROLE/DB, NOREPLICATION, NOBYPASSRLS). `test/isolation/share-token-gate-lookup.spec.ts` asserts the same against pg_proc (not runnable at this tip, see below) | pass |
| Owner's reach is bounded: column SELECT on share_tokens only, no write, no other table, no schema CREATE | "DEF-2" (label/prefix/created_by/`*` denied 42501; UPDATE/DELETE denied; users/projects/workspaces denied; no table-level grants), "DEF-7" (owns exactly one object, no CREATE on app or public) | pass |
| search_path pinned | "DEF-5" (`pg_catalog, pg_temp` exactly; a look-alike `evil.share_tokens` first on the caller's path changes nothing) | pass |
| EXECUTE granted only to the runtime role | "DEF-6" (worker, report, portal get 42501; only nominara_app holds EXECUTE among non-superusers; PUBLIC false); the pre-existing "SECURITY DEFINER ... executable by nominara_app and by nobody else" in `share-token-gate-rls.spec.ts` | pass |
| Runtime role still cannot read share_tokens without context | "DEF-4" (all four runtime roles read 0 rows; nominara_app cannot `SET ROLE` the owner, 42501) | pass |
| Only the hashed token's row, isolation under SET ROLE nominara_app (the isolation suites cannot run at this tip) | "DEF-3", "DEF-4" run as the real `nominara_app` pool, not the superuser | pass |
| ISO-07 unchanged | "DEF-8" (only nominara_breakglass has rolbypassrls on the fully migrated schema) | pass |
| rls-check knows the new policy and still flags strays | `rls-check.spec.ts` (29 tests; 0112 and 0080 added to its migration set), "DEF-9" (one policy, FOR SELECT, TO owner only, qual `true`, no WITH CHECK; ws_isolation unchanged), unit `rls-generate.spec.ts` DEF-U1..U3 | pass |
| Reversible | "DEF-10" (rollback to 0112: owner back to the migration identity, policy and grants gone, lookup still works, re-apply restores the dedicated owner) | pass |
| Mutation check | with the CREATE POLICY line removed from 0112, DEF-3, DEF-5, DEF-9 fail (3 failed, exit 1); file restored | done |
| 098b portal session behaviour unchanged by the new owner | `portal-session-http.spec.ts`, `portal-context-http.spec.ts`, `share-token-gate-rls.spec.ts` all pass on the 0112 tree | pass |

## Gates (all on 13d71c8 plus this file)

- `pnpm lint` exit 0
- `pnpm typecheck` exit 0
- `pnpm test:unit` exit 0 (277 files passed, 1 skipped; 3316 tests passed, 1 skipped)
- Integration, 11 files, 173 tests, exit 0: share-token-lookup-definer, share-token-gate-rls, portal-session-http,
  portal-context-http, database-roles-and-grants, rls-check, track-e-sharing-migration, migrations,
  generated-rls-and-tenant-context, readiness-as-runtime-role, scoped-list-routes-http.
  Run with `DOCKER_HOST` set to the colima socket and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.

## Not done, stated

- `test:isolation` / `:breakers` were not run: the support_grants TTL fixture crash is known at this tip (d-admin lane).
  The merge step must run them; `share-token-gate-lookup.spec.ts` (updated here) and ISO-07 are the relevant ones.
- `db:rls-generate --check` / `db:drift-check` / `db:schema-check` were not run: they need `DATABASE_URL`, and the only
  database reachable is the owner's on 55432, which this lane may not touch. No generated file changes (no new table or
  column; the policy is hand-written, declared to rls-check). The role is not added to `DATABASE_ROLES` because
  `database-roles-and-grants.spec.ts` migrates 0001-0005 only; DEF-1 asserts its attributes. Evidence needing a real API
  is collected in NEW-A-17.
- OpenTelemetry spans are deferred to week 2 (owner decision R3). No new metric or log line: this change is a database
  ownership change with no request-path code.
- Remaining 098b CP2 notes not addressed here: POST /portal/session writes view rows but no audit row; the observability
  line has no asserting test; `schemas/tools-attribution-agency.md` does not yet list failed_attempts, locked_until or
  share_token_by_hash (docs repo has no .git here, so that edit must be carried over). The README now documents the
  new owner role (G-4 addendum), which is the runbook QA asked for.
