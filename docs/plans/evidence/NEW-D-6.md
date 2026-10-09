# NEW-D-6 — usage counters read and capped auto-top-up configuration

Lane `7day/d-usage-3`, base `integration/7day` @ f201f35. Migrations: none (the columns and
`ck_autotopup_bounded` shipped in 0002; `usage_counters` in 0002/0019).

- RED commit: `6be4d3f` — `test/integration/billing-usage-auto-topup.spec.ts`, 19 tests,
  **19 failed (19), exit 1**. Reasons: `Cannot PUT /v1/billing/wallet/auto-topup` and
  `Cannot GET /v1/billing/usage` (404), and `auto_topup` absent from the wallet body.
- GREEN commit: `feat(billing): NEW-D-6 — ...` (the commit that carries this file).
- Contract: `autoTopupRequestSchema` (`.strict()`, 1..20), `autoTopupConfigSchema` and
  `usageResponseSchema` landed in NEW-D-1. This item adds only the `auto_topup` member to
  `walletResponseSchema` (the schema's own comment said it would arrive with its handler; adding it
  earlier would have broken the live wallet handler's typing), so it is in the same commit as the
  handler, not a separate contract commit. `contracts/openapi.generated.json` regenerated;
  `contracts:check` exit 0.
- Integration test edit: `test/integration/credit-ledger-read.spec.ts` — two exact-equality wallet
  assertions gained the new `auto_topup` default (off). A key was added; nothing was relaxed.
- One RED-spec edit made with the implementation: the `periodStart` helper (counters roll with the
  wallet cycle, then the live subscription period, then the calendar month). No assertion changed.

## Acceptance criteria

All tests are in `test/integration/billing-usage-auto-topup.spec.ts` (real ApiModule, real Postgres,
requests served as `nominara_app`, so RLS is in force).

| # | Criterion | Proof (test name) |
|---|---|---|
| 1a | PUT requires `billing:write` | "STORY-076 AC6 scenario 6 · a viewer or manager is refused with 403 naming billing:write, and nothing is written" |
| 1b | PUT requires Growth+ (`feature_not_in_plan`, `min_plan: growth`; decided in SQL from `plans.sort_order`) | "... a Starter workspace is 403 feature_not_in_plan naming growth" |
| 1c | max_per_cycle above the cap is rejected; boundaries 0/21/1.5/-1 refused, 1 and 20 accepted | "... max_per_cycle above the cap is a 400 at the contract; 0 and 21 are refused, 1 and 20 are accepted" |
| 1d | `ck_autotopup_bounded` is the control: a direct write of 21 is SQLSTATE 23514 (also 0, and enabled without a pack key) | "... ck_autotopup_bounded is the control: a direct write of 21 is SQLSTATE 23514, ..." |
| 1e | strict body, enabled-needs-fields, unknown pack are 400 | "... unknown keys, an enabled config missing fields, and an unknown pack are all 400" |
| 1f | the config round-trips through PUT and `GET /billing/wallet` (`auto_topup`) | "STORY-076 AC6 · a valid PUT returns the config, stores it, and GET /billing/wallet reads it back under auto_topup"; "... disabling stores enabled=false and may carry nulls" |
| 2 | A mid-cycle configuration change does not reset `auto_topup_count_cycle` | "STORY-076 AC8 scenario 8 · ..." (counter 3 survives a cap change, a disable, and a re-enable). Mutation: adding `auto_topup_count_cycle = 0` to the UPDATE fails this test only. |
| 3 | Off by default for every new wallet | "NEW-D-6 · auto top-up is off by default: a workspace with no wallet row ..." and "... a wallet row provisioned by anything else has the column default false" |
| 4 | Every configuration change writes an audit row (`billing.auto_topup.updated`, `credit_wallet`, actor = caller); a refused change writes none | "NEW-D-6 · every configuration change writes an audit row, and a refused change writes none" |
| 5a | `GET /billing/usage` reads `usage_counters` for the current period in the usage contract | "NEW-D-6 · GET /billing/usage reads the current period's counter in the usage contract" |
| 5b | `cap` null = unlimited, `cap` 0 = tier has none (distinct) | "... cap null means unlimited and cap 0 means the tier has none". Mutation (`limit \|\| null`) fails it. |
| 5c | no row yet: `used: 0`, cap from the plan, and the GET creates no row | "... with no counter row yet, used is 0 and the cap comes from the plan (read-only ...)" |
| 5d | only the current period; unpublished metrics (`fair_use_captures`) never appear | "... only the current period's counter is read, and the unpublished metrics never appear" |
| 5e | `share_links_active` = unrevoked and unexpired | "... share_links_active counts unrevoked, unexpired tokens only". Mutation (drop the expiry clause) fails it. |
| 5f | requires `billing:read` (403 naming it) | "... GET /billing/usage requires billing:read: a manager and a viewer are 403 naming it" |
| 5g | tenant-isolated | "... usage and auto-top-up are tenant-isolated: another workspace's counters, tokens and config never appear" |
| obs | metric `nominara_billing_auto_topup_update_total` and a redacted log line (workspace id, no pack key, no threshold) | "NEW-D-6 · a PUT emits nominara_billing_auto_topup_update_total and a log line ..." |

Mutation checks run (each fails exactly the named test): count reset in the UPDATE; Growth+ check
replaced by `true`; expiry clause removed from `share_links_active`; `-1 -> null` mapping broken.

## Not met this week, stated explicitly

- **OpenTelemetry span**: deferred to week 2 by owner decision; not a failed criterion.
- **`trigger_active` is always `false`**: the configuration ships, the off-session trigger does not
  (contract comment, week 1). Nothing charges a card from this item. The "every trigger emails the
  billing contact" half of STORY-076 AC7 belongs with the trigger, not here.
- **Real running API** evidence: collected in NEW-A-17.
- **Frontend** (BillingSettings form, cap range from the contract, usage panel): not in this
  api-only item.
- `test:isolation` / `:breakers`: crash in fixture setup at this tip (support_grants TTL fixture; the
  d-admin lane fixes it). No table, policy or migration was touched. Tenant isolation is proven in
  the spec above under `nominara_app` (criterion 5g).

## Decisions taken (flag if wrong)

- `GET /billing/wallet` stays `billing:read` as already built (api-specification.md §3 says
  `workspace:read`; unchanged here, so a viewer still cannot read `auto_topup`).
- A `PUT` on a workspace with no wallet row provisions it (same grant logic as the credit-pack
  settlement) so the configuration has a row to live in.
- A `pack_key` that exists but is above the workspace tier is `403 feature_not_in_plan`; an unknown
  one is `400`.
- `used` in the usage read is committed use (`used_value`), not `used + reserved`.

## Gates (this worktree, base f201f35 + this lane)

| Command | Exit |
|---|---|
| `pnpm lint` | 0 |
| `pnpm typecheck` | 0 |
| `pnpm test:unit` | 0 (277 files passed, 1 skipped; 3313 tests) |
| `pnpm contracts:check` | 0 |
| integration: `billing-usage-auto-topup.spec.ts` | 0 (19 passed) |
| integration: `credit-ledger-read.spec.ts` | 0 (37 passed) |
| integration: `estimates-and-confirmation.spec.ts`, `credit-packs.spec.ts` | 0 (with the above: 102 tests, the 2 failures were the exact-equality wallet assertions fixed above) |

## Checkpoint-3 fix pass (lane `7day/d-usage-4`)

- The wallet's required `auto_topup` member is recorded as an approved breaking change: `contracts/baseline/breaking-changes.json`
  entry `2026-10-08-wallet-auto-topup-required` (commit `90b8a28`), asserted by `test/unit/contract-breaking-changes.spec.ts`.
- `trigger_active` is now `true` (the trigger is wired by NEW-D-7); the three expectations of the old literal in
  `billing-usage-auto-topup.spec.ts` and `credit-ledger-read.spec.ts` were updated for that and nothing else changed in them.
- STORY-076 AC8 (a mid-cycle configuration change does not reset `auto_topup_count_cycle`) still holds and is re-run:
  `billing-usage-auto-topup.spec.ts` passes (it never ran at checkpoint 3). The counter now resets only when the billing
  period rolls (NEW-D-7 evidence, finding 3).
- Gates for this pass are in `NEW-D-7.md`.
