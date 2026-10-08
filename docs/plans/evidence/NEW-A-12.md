# NEW-A-12 evidence (checkpoint 2, lane 7day/a-api-3)

QA passed this item at checkpoint 2. Recorded here for completeness; no code changed this checkpoint.
Spans deferred to week 2 (owner decision R3); the revoke metric and redacted log line are in code and in the tests below.

| # | Criterion | Proof |
|---|---|---|
| 1 | Contract first; member name/email additive; workspace-detail and invitation-revoke schemas | cae4ff1 (contracts alone). cae4ff1 did not regenerate openapi (QA gap); 37edfd6 regenerated it and made `name`/`email` optional so the diff is minor (RED d3e9c89, 1 RED). Under decision R5 an added optional field is minor everywhere. |
| 2 | Isolation as `nominara_app`: members of A never include a B-only user; path id != token ws claim is 403 | `test/integration/workspace-members-detail-revoke.spec.ts` (9 tests; runs as nominara_app). RED 2721836: 7 of 9 failed for the right reasons (404 / missing name,email). |
| 3 | Revoke needs `member:invite`, writes an audit event, 404 for another tenant's invitation | same spec; QA mutations killed: drop @Audit (4 fail), weaker permission (1), drop pending-only predicate (1), drop path==claim check (1). |
| 4 | dangerous-area-auditor second engineer | The single finding (major contract bump) is fixed (37edfd6). No formal re-approval is recorded; a re-audit must be run by the auditor, not by this lane. |

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
