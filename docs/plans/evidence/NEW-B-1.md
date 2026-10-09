# NEW-B-1 evidence — PATCH/GET /v1/me (checkpoint-4 close-out)

Branch `7day/b-ws-5` from integration/7day 74e4b2f. Date 2026-10-09. The API was built under NEW-A-2 (contracts `64c1dbb`, impl `c8ebb5f`);
this file maps NEW-B-1's criteria to that work and records the checkpoint-4 fix.

Commits: RED `e4209fd` (identity-me.spec.ts, 5 NEW-B-1 cases), RED amendment `01260cb` (suspended expectation 401 -> 403), fix: see `git log`
("fix(identity): NEW-B-1 checkpoint-4").

## What checkpoint 4 found
A user with `users.status = 'suspended'` and a live session got 200 on GET /v1/me and PATCH wrote the row. AuthGuard checked only
`sessions.revoked_at`. The erased path (deleted_at) was correct but unproved.

## Decision recorded: suspended is 403, not 401
The first RED expected 401 for suspended. Untouched `identity-passkey-registration-proves-email.spec.ts` > "STORY-173 · AC5 — a suspended
account, even with a proved address, cannot add a passkey" pins 403 and went red under the 401 fix. That test is the evidence: an existing
account that is forbidden is 403 (`forbidden`); erased, deleted or a missing user row is 401 like a revoked session. The RED was amended
(`01260cb`), not the AC5 test. The guard is the single enforcement point, so every authenticated route inherits it.
'unverified' is deliberately admitted (STORY-173: such a user holds a session to prove the address).

## Criteria
| Criterion | Proof | Result |
|---|---|---|
| Contracts in own commit | `64c1dbb` (me-update-request) | met earlier |
| GET returns session user, active_workspace_id = token ws claim | identity-me.spec.ts (NEW-A-2 cases) | met earlier |
| PATCH persona refuses out-of-vocabulary with 400 | identity-me.spec.ts "rejects ... lt_1k with 400" | met earlier |
| Session-only route, unauthenticated 401 | identity-me.spec.ts; route-permission-coverage allow-list | met earlier |
| Suspended user refused on GET /me, nothing returned | integration "NEW-B-1 · a suspended user with a live session is refused on GET /me and nothing is returned" (403) | met |
| Suspended user refused on PATCH /me, row not written | integration "... refused on PATCH /me and the row is not written" | met |
| Refused on another authenticated route | integration "... refused on another authenticated route (GET /workspaces), not only /me" | met |
| Erased user refused | integration "an erased user (deleted_at set) with a live session is refused on GET and PATCH /me" (401) | met |
| Reinstatement restores access | integration "reinstating a suspended user ... restores access on the same session" | met |
| Guard unit cases (suspended 403; erased/deleted/missing 401; unverified admitted) | auth.guard.spec.ts "NEW-B-1 · refuses a live session ..." and "... unverified user's session is still admitted" | met |

## Gates (worktree api-wt-b2)
- RED `e4209fd` ran failing before the fix (previous attempt); amended RED `01260cb` is red against the unfixed guard by construction (suspended returned 200).
- `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm test:unit` exit 0 (306 files passed, 1 skipped; 3757 tests).
- Integration (identity-me, identity-session-model, rbac-guard-and-step-up, session-refresh-*, realtime-room-authorization,
  identity-passkey-registration-proves-email, identity-oauth-proves-email, portal-session-http): exit 0, 9 files / 190 tests.
- `test:isolation` not run: no tenant table or policy changed; the guard adds a read of `users` joined from `sessions` on the pool.

## Not done
No auditor verdict; no OpenTelemetry span change. The guard adds no new metric; the existing problem-filter log line carries code and workspace id only.
