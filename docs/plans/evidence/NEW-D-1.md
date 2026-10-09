# NEW-D-1 Track D zod contracts — checkpoint-4 evidence (lane 7day/d-billing-5, base integration/7day 74e4b2f)

This file did not exist; it covers the checkpoint-4 repair of AC3 and AC5's record-keeping. The original contract commit is `4c9a5e6`.

## Commits
| Sha | What |
|---|---|
| `e2f1bd1` RED | `test/unit/pagination-published-contract.spec.ts` (3 tests, 3 failed: `listInvoices` has no cursor/limit/pagination in the published document; `listCreditPacks` has none; the sweep names `listInvoices` and `listCreditLedger`) and two credit-packs integration tests (2 failed / 25 passed: `pagination` undefined; `?cursor=not-a-cursor` and `?offset=1` returned 200). The failures are assertion failures, the stated reason. |
| `be105d0` contract | `creditPackListResponseSchema` comment: the "handful of rows, so a bare array" argument reversed AC3 and is withdrawn. |
| `d6916d8` fix | `GET /billing/credit-packs` takes `creditPackListQuerySchema` and is `listOf: true`; the service pages the tier-filtered set by cursor on `(sort_order, credits, key)` (`key` is unique); `PurchasableOption` gains `sortOrder` (additive). `listOf: true` also on `listInvoices` and `listCreditLedger`. `openapi.generated.json` regenerated. |
| `1e06bf3`, `37814f6` record | `contracts/baseline/breaking-changes.json`: five entries (below). `37814f6` removed price literals from an entry's text because `no-hardcoded-plan-values` rightly scans that file. |

## Criteria
| Criterion | Proof |
|---|---|
| AC3 every list response uses the cursor envelope: credit-packs | integration `credit-packs.spec.ts` > "NEW-D-1 AC3 · the catalog uses the cursor envelope: pagination on the wire, a limit=1 walk visits each pack exactly once, in order, then ends"; "NEW-D-1 AC3 · a malformed catalog cursor and an offset parameter are 400s"; unit "NEW-D-1 AC3 · listCreditPacks is a cursor list..." |
| AC3 invoices (also STORY-075b AC3) | unit "STORY-075b AC3 · listInvoices publishes a required `pagination` member and the cursor/limit parameters" |
| AC3 sweep from the hazard | unit "every GET that accepts a `cursor` publishes a required `pagination` member (sweep from the hazard, no allow-list)" |
| AC4 contracts:generate / check / diff, `major` recorded | `contracts:check` exit 0. `contracts:diff` of the previous document against the new one prints `major`; each cause is recorded: credit-packs, invoices, ledger, add-ons list, add-ons POST (`test/unit/contract-breaking-changes.spec.ts` asserts each stays visible: 43 passed with the new entries) |
| AC5 owner decisions resolved before the commit | PARTLY. The read-only API-key default is in `decisions-2026-10-08.md`. The audit `category` derivation, the usage shape and where the auto-top-up config is read from are labelled OWNER DECISION in contract comments but appear in no decisions file. Not fixed here: it needs the owner to write them down. |

## Not fixed by this lane (named so they are not lost)
- `GET /v1/api-keys` still returns a bare array, served from `contracts/workspaces/api-key.schema.ts`; `contracts/trust/api-key.schema.ts` is a dead duplicate. The checkpoint-4 task did not name it and the other module (`api-keys`) is not this lane's.
- The sweep test proves routes that ACCEPT a cursor publish `pagination`. A bare-array list that accepts none (`listApiKeys`, `listProjectGoals`, `listShareTokens`, ...) is invisible to it by construction; the cursor-envelope rule for those is a decision for the lead.
- `listCreditLedger` was fixed beyond the named routes (same one-token defect, same module). It is recorded in breaking-changes.json with a note that it needs the lead's confirmation.

## Authority for the breaking-changes records
"Owner-approved under the NEW-D-1 cursor-envelope rule" cites NEW-D-1 AC3 in the signed-off `track-plans.json` and the fix-pass task text. It is not a numbered item in `decisions-2026-10-08.md`; the entries say so.

## Observability
No new behaviour on a new path beyond the existing list handlers; no metric was added for the catalog read (it has none today). Stated, not hidden. Spans deferred to week 2 (R3).

## Mutation proofs (each reverted)
| Mutation | Result |
|---|---|
| cursor filter `> 0` to `>= 0` in `CreditPacksService.list` (repeats the last pack) | the walk test fails; 1 failed / 26 passed |
| remove `listOf: true` from `listInvoices` | 2 of 3 unit tests fail (the named test and the sweep) |

## Gates (api-wt-d1)
`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test:unit` 0 (3776 passed, 1 skipped) · `pnpm contracts:check` 0 · `pnpm test:isolation` 0 (13 / 53) · integration (`audit-log-http`, `auto-topup-trigger`, `billing-addons`, `billing-invoices`, `billing-usage-auto-topup`, `credit-ledger-read`, `credit-packs`, `credit-guard-settlement`, `auto-topup-enqueue`, `auto-topup-cycle-reset`) 0: 10 files / 267 tests.
