# NEW-A-2 evidence (checkpoint 2, lane 7day/a-api-3)

Observability: spans deferred to week 2 (owner decision R3). Unchanged this checkpoint: no code in this item changed.

## What checkpoint 2 failed, and why it cannot be closed here
The single failed criterion is AC4, "Frontend `useMe()` works in api mode; the app shell resolves the active workspace from it".
It lives in the frontend lane (7day/fe, app-wt-fe): `getMe`/`savePersona` call the typed client, but the frontend typecheck is red
at checkpoint 2 (VisibilityPanel `blend`, PromptsSection `engines.find`, lib/demo/data.ts `data_source`) and app-fnt-dev-main still
uses `pending<Me>()`. Nothing in this API lane can make that true. The running-API proof (a real session, `GET /v1/me`,
the shell resolving the workspace) is collected in NEW-A-17. Not met this week from this lane, stated rather than left silent.

## API-side acceptance criteria (met; code unchanged by this checkpoint)
| # | Criterion | Proof |
|---|---|---|
| 1 | Contract lands alone first, `.strict()`, openapi regenerated | 64c1dbb (contracts only) precedes c8ebb5f. `pnpm contracts:check` exit 0 at HEAD. |
| 2 | GET /me returns user, `active_workspace_id`, persona, locale, timezone; 401 unauthenticated; PATCH unknown field 400; PATCH persists and echoes | `test/integration/identity-me.spec.ts`: "NEW-A-2 · GET /me returns the caller's identity, locale, timezone, a null workspace and a null persona", "...GET /me without a session is 401", "...PATCH with an unknown top-level field is 400", "...unknown persona field is 400", "...PATCH /me persists the persona and echoes it...", also skipped-vs-null, whole-persona replace, retired `lt_1k` volume, empty body, CSRF. |
| 3 | Never another user's data; `active_workspace_id` from the verified token claim | "NEW-A-2 · GET /me never returns another user's data, and PATCH never writes another user's row", "NEW-A-2 · active_workspace_id is the token's ws claim, never a query or body value". |

## RED evidence
The original lane committed the spec and the implementation together in c8ebb5f (no separate RED commit; that cannot be recreated
honestly after the fact). Reconstruction run this checkpoint: `src/modules/identity` set to the contracts-only parent 64c1dbb,
spec unchanged -> `identity-me.spec.ts` 14 of 14 FAIL, exit 1, for the stated reason (`GET/PATCH /v1/me` routes absent, so
404 / no behaviour). Restored to HEAD -> identity-me, workspace-members-detail-revoke and data-source: 31/31 pass, exit 0.

## Gates
All run in /Users/sarwaralam/Desktop/Projects/ElegantTech/nominara/api-wt-a2 on 7day/a-api-3, Docker via testcontainers (pgvector:pg18).
- `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm contracts:generate` no diff; `pnpm contracts:check` exit 0.
- `pnpm test:unit` exit 0: 277 files passed, 1 skipped; 3316 tests passed, 1 skipped. (One earlier full run, concurrent with a
  container run on a machine at load average 17, failed `src/api/guards/rbac.guard.spec.ts` "a manager scoped to projects...";
  the file passes alone, 21/21, and passes in the clean full re-run. It is a file this lane did not touch.)
- `vitest run --config vitest.integration.config.ts` on seed-demo, workspace-summary, identity-me, workspace-members-detail-revoke,
  data-source, openapi-route-and-strictness, project-seeds, workspace-invitations, workspace-members-and-roles: exit 0,
  9 files / 110 tests passed.
- `pnpm test:isolation` / `test:isolation:breakers`: not run; they crash in fixture setup at this tip (`ck_support_ttl_max`, d-admin lane).
  No tenant table, migration or RLS policy was touched by this lane (no db:rls-generate needed). The merge step runs the isolation suites.
- Evidence that needs a running real API (session -> GET /v1/me, data_source on live responses) is collected in NEW-A-17.

- Audit 4: NEW-A-2 is NOT closed from this lane. The failed criterion (frontend useMe() in api mode) is the fe lane's and NEW-A-17's; the item stays FAILED / reassigned to fe + NEW-A-17.

## Fix pass (branch 7day/a-api-4 from integration/7day fee788e): API half
No code changed. API-half criteria 1-3 above re-verified at fee788e: `npx vitest run --config vitest.integration.config.ts test/integration/identity-me.spec.ts test/integration/data-source.spec.ts test/integration/workspace-summary.spec.ts` -> 3 files / 34 tests passed, exit 0.
Gates: `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test:unit` 0 (3697 passed / 1 skipped).
AC4 (frontend `useMe()` in api mode) is the fe lane's (NEW-A-14 frontend half) and NEW-A-17's; this lane makes no claim on it.
