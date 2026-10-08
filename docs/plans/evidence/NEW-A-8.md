# NEW-A-8 evidence (checkpoint 2, lane 7day/a-api-3)

Tip: see `git log` on 7day/a-api-3. Fix commit for this item: 4b1e129 (test fixture). Tenant isolation here is proved by the
seed running through the pooled `nominara_app` connection (`assertPooledConnectionIsRuntimeApp`) in every test of the spec.
OpenTelemetry spans are deferred to week 2 (owner decision 3, 2026-10-08): a missing span is not a failed criterion this week.
The seed is a CLI, not a request path, so its observability is the redacted log lines it already writes (workspace ID only).

## Why QA failed it, and the fix
`createActiveProject` in `test/integration/seed-demo.spec.ts` inserted only a `projects` row. After the audit fix 1d0ae38
(`--facts-only` writes against EXISTING prompts and competitors, inserts none) eight tests had nothing to write against and
failed (`#1, audit-1, #2c, #3, #3b, #3c, #4, #6`). The implementation was right; the fixture was not a real customer project.
4b1e129 makes the fixture insert one active prompt and one competitor (a real project owns both). No assertion was changed or
relaxed. (A first draft of the fixture bound `$3` under two casts and failed with "inconsistent types deduced"; the text is bound
twice, as `src/db/seed/demo/facts.ts` does.)

## Acceptance criteria
| # | Criterion | Proof |
|---|---|---|
| 1 | RED first: `--facts-only --exclude-engines gemini` writes demo-marked facts only for the other five entitled engines | `test/integration/seed-demo.spec.ts` > "NEW-A-8 #1 · ..." (also #2c, #4, #5, #6). Original RED: a7f46bf, 7 of 10 integration tests failed for the stated reasons (gemini present, wallet=1, 3 projects, no refusal), unit args spec 1 of 5 (QA reproduction, checkpoint 2). GREEN at HEAD: 13 of 13 NEW-A-8 tests pass, exit 0 (`vitest run --config vitest.integration.config.ts test/integration/seed-demo.spec.ts -t NEW-A-8`). |
| 2 | `--facts-only` never provisions or touches a wallet or ledger (money path) | "NEW-A-8 #2" (no wallet row, no ledger row, no statement naming `credit_wallets`/`credit_ledger` on the tenant connection) and "NEW-A-8 #2b" (an existing wallet and ledger are byte-identical, same `xmin`). **Mutation proof, run this checkpoint:** M1 = call `ensureDemoWallet` in the facts-only branch of `src/db/seed-demo.ts` -> "NEW-A-8 #2" FAILS (1 failed, exit 1); source restored. M2 = run `ensureDemoProjects` under `--facts-only` -> "NEW-A-8 #2c" FAILS (1 failed, exit 1); source restored. So #2/#2c no longer pass trivially. **Re-audit:** the dangerous-area-auditor has NOT re-reviewed fix 1d0ae38 + the fixture; I cannot run that agent from this lane. It must be run before this criterion is signed off (money-path mutations A8-1..A8-3 of the auditor are still unrun). |
| 3 | Three-condition guard unchanged; `--purge` removes only demo-marked rows and never a real Gemini capture | "NEW-A-8 #7" (production and non-local target refused; opt-in required); "NEW-A-8 #3" and "#3b" and "#3c". `src/db/seed/demo/guard.ts` is untouched on this branch (`git diff f201f35..HEAD -- src/db/seed/demo/guard.ts` is empty). |
| 4 | Re-running on the same day gives byte-identical demo rows | "NEW-A-8 #4". |
| audit | `--facts-only` inserts no prompt and no competitor; project/prompt/competitor rows untouched (count and xmin); facts land on the project's real prompt | "NEW-A-8 audit · --facts-only inserts no prompt and no competitor..." and "NEW-A-8 audit · --facts-only on a project with no prompts writes nothing and inserts nothing". **RED, right reason, re-run this checkpoint:** with `src/db/seed-demo.ts`, `facts.ts`, `seed-project.ts` set back to `1d0ae38^` and the fixed fixture, both audit tests FAIL (2 failed, exit 1) because the old code inserted prompts and competitors; with the fixed source they pass. (The original RED commit e82c300 had failed for the WRONG reason: the missing-fixture precondition.) |

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
