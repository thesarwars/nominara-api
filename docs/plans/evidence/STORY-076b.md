# STORY-076b evidence

Add-ons as Stripe subscription items: `GET|POST /v1/billing/addons`, `DELETE /v1/billing/addons/{kind}`, and the webhook reconciler for `subscription_addons`. Branch `7day/d-billing-3`, base `integration/7day`.

Commits: contract `e112523` · RED `235e0ab` · implementation `c279f9b` (this file follows).
The implementation commit also adds the one-line `AddonListQuery` type export to `contracts/billing/addon.schema.ts` that the contract commit omitted (no schema change).

## STATUS: PARTIAL — the integration spec is written and typechecks, but it has NOT been run

`df -h /System/Volumes/Data` showed 6.1 GiB free (rule: under 8 GiB, do not start testcontainers). So:

- RAN and green: the four unit specs below (42 tests), lint, typecheck, `contracts:generate`/`contracts:check`/`contracts:diff` (minor), the whole unit suite, 12 hand mutations.
- NOT RUN: `test/integration/billing-addons.spec.ts` (30 tests, every row of the real-database proof below). Its RED state was therefore NOT observed against a database. To finish, free disk to 8 GiB, then
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true pnpm exec vitest run --config vitest.integration.config.ts test/integration/billing-addons.spec.ts test/integration/stripe-subscriptions.spec.ts test/integration/stripe-webhook.spec.ts test/integration/entitlement-resolution.spec.ts`
  and treat any failure as a defect in the implementation OR the spec (written without a database to check it against). One assertion was already adjusted once for a typed-error constraint (see "Decisions").
- `test:isolation` not run (no tenant table touched; `subscription_addons` already has its generated RLS policy). Isolation is proved in the integration spec under `nominara_app` (not run, as above).

## RED

| Commit | What | Result |
|---|---|---|
| `235e0ab` | `src/lib/billing/addon-grant.spec.ts` and `src/lib/billing/stripe/addon-items.spec.ts` against missing `addon-catalog.ts` / `addon-items.ts` | `vitest run` exit 1: "Failed to resolve import", 2 files failed, 0 tests ran (the stated reason) |
| `235e0ab` | `test/integration/billing-addons.spec.ts` | NOT run (disk). It does not typecheck at that commit (the fake gateway had no `addonChanges`/`reset`); after `c279f9b` it does. Its RED would be a 404 on `/billing/addons` and no reconciler rows |

After `c279f9b`: the two RED specs pass (15 tests). The service spec (18) and the gateway spec (9) were written with the implementation, not RED-first; they were mutation-tested instead (below).

## Acceptance criteria

| Criterion | Proof | Status |
|---|---|---|
| AC1 (STORY-076 AC10): add/remove changes the Stripe item quantity with proration | U `billing-addons.service.spec.ts` > "AC1 · sets the item to current + requested from a FRESH fetch, and issues no INSERT/UPDATE of its own"; U `stripe-http.addons.spec.ts` > "a new item is created from inline price_data on a fixed product, with proration…", "an existing item is updated to the TOTAL with proration"; S `billing-addons.spec.ts` > "AC1 · POST adds a NEW subscription item in Stripe with proration and writes NOTHING local" | unit met; S not run |
| AC1: local `subscription_addons`, `seats_purchased`, `projects_purchased` written ONLY by the fresh-fetch reconciler, never by POST | U "…issues no INSERT/UPDATE of its own" (asserts no write SQL in the POST path); S "POST … writes NOTHING local" (rows, counters and entitlement_version unchanged); S "AC1 + AC5 · the fresh-fetch reconciler writes the add-on row, seats_purchased and projects_purchased…"; the only writer is `BillingAddonsService.reconcile`, called from `StripeSubscriptionHandler` after the signature, fetch and workspace lock | unit met; S not run |
| AC1 robustness: total comes from a FRESH fetch, not the stale local row; cap; price from OUR catalog | S "adding to a held add-on updates the SAME item to the total taken from a FRESH Stripe fetch"; U "AC1 boundary · exactly the cap is accepted, one over is a 400"; S "the price and currency come from OUR catalog… a forged `unit_price_usd` is a 400"; U `addon-grant.spec.ts` > "the owner-approved prices, as numeric(12,2) text" | unit met; S not run |
| AC1 redelivery / removal: unchanged event writes nothing; an item that left Stripe is closed, not deleted | U "idempotent · an identical set writes nothing, bumps nothing and audits nothing", "an add-on missing from the fetch is closed with active_until, not deleted", "a changed quantity, price or item id updates the row in place"; S "a redelivered or unchanged event writes nothing…", "an add-on that left Stripe's subscription is closed…and buying it again opens a NEW active row", "an ended subscription closes every add-on" | unit met; S not run |
| AC2 (AC11 / scenario 10): extra_project shows projects.max+1 AND the prompt slots | U `addon-grant.spec.ts` > "scenario 10 · an extra project grants a project slot AND its prompt slots", "the grant equals what the resolver actually adds for one unit (they cannot disagree)" (the grant is derived from `addonContributions`, `src/lib/entitlements/resolution.ts`, which is unchanged); S "AC2 · scenario 10 · after an extra_project lands, projects.max is +1 AND the prompt slots are granted" (resolves entitlements after the webhook) | unit met; S not run |
| AC2 (scenario 11): GET returns the grant statement | U "scenario 11 · the statement names BOTH halves of the grant"; S "AC2 · scenario 11 · GET /billing/addons returns the grant statement, the price and the cursor envelope" (growth: "1 project", "40 prompt slots"); S empty list; S cursor paging and forged cursor 400 | unit met; S not run |
| AC3 (AC12 / scenario 12): removing a seat while members exceed the reduced limit is 409 BEFORE any Stripe call | U "AC3 · scenario 12 · members over the reduced limit is a 409 and NO Stripe call of any kind" (no remove, fetch or change); U boundary at the limit; U "an override is absolute"; S "AC3 · scenario 12" (asserts `gateway.fetches` unchanged) and S "AC3 boundary" incl. a removed member freeing the seat. The count is the same `status <> 'removed'` the seat ceiling uses | unit met; S not run |
| AC4 (AC13 / scenario 13): removal follows the period-end policy; deferral stated if STORY-077 is not built | STORY-077 is NOT built (no code names it beyond comments). DELETE schedules the item's removal at the current period end (`scheduleAddonRemoval`); U "AC4 · scenario 13 · schedules at the CURRENT PERIOD END against the held item and writes nothing local", U `stripe-http.addons.spec.ts` > "AC4 · keeps the current phase to the period end and drops ONLY the add-on's price from the phase after it, then releases"; S "AC4 · scenario 13 …", "once Stripe applies the removal … the reconciler closes the add-on". **Deferred and stated** (header of `billing-addons.service.ts`): the structural follow-through (pausing projects, prompts and seats that no longer fit) is STORY-077's | unit met; S not run; deferral stated |
| AC5: any add-on change bumps entitlement_version | U "AC1 · opens a row per new add-on … bumps the version once", "AC5 · does not bump a second time when applyPlanChange already did"; S "AC5 · a change that moves ONLY the add-on rows (not the counters) still bumps entitlement_version" | unit met; S not run |
| AC6: free or ineligible tiers get 403 feature_not_in_plan with min_plan | U "AC6 · a plan that does not grant the flag is feature_not_in_plan naming the tier from `plans`, before any lock or Stripe call"; S "AC6 · free is refused … for both kinds" (`min_plan` growth for a project, starter for a seat), S "starter may buy a seat but not a project". `min_plan` is read from `plans`, never named in code | unit met; S not run |
| AC7: every change writes an audit row | S "AC7 · every change writes an audit row: the request, the removal, and the reconciliation" (`billing.addon.change_requested`, `billing.addon.removal_scheduled` via `@Audit`; `billing.addons_reconciled` inside the webhook transaction via `AuditChainService`, so an audit failure rolls the change back); U asserts the reconcile audit call (actor system, event id as `requestId`, before/after quantities); S "a refused change writes no change audit row" | unit met (reconcile); S not run |
| Permissions | S "GET is billing:read and POST/DELETE are billing:write: a manager and a viewer are refused with a 403 naming the permission" (`@RequirePermission`) | S not run |
| Tenant isolation, RLS only | S "tenant isolation" x3 (list scoped; unfiltered read as `nominara_app` sees only A and cannot insert for B; an event for A writes nothing in B). The list/reconcile queries carry no `workspace_id` predicate where RLS applies | S not run |
| Request validation (`.strict()`, bounds) | S "request validation: quantity 0, 101, fractional, unknown kind, missing quantity are 400s; the Idempotency-Key is required"; unknown key 400 | S not run |
| Failure modes | U/S Stripe unavailable and unconfigured are 503 `degraded`, no local change, no Stripe text; S annual subscription is 409; U no Stripe subscription is `precondition_unmet` | unit met; S not run |
| Metric | `nominara_billing_addon_change_total{kind,outcome}`, `nominara_billing_addon_reconcile_total{outcome}` — emitted (visible in the unit run's metric log lines); no separate assertion on the counters | emitted |
| Redacted log | `add-on change requested` / `removal scheduled` / `add-ons reconciled from stripe` carry `workspace_id`, kind and quantities only; Stripe failure logs a status code only. S "redaction · the audit rows and responses carry no Stripe ids beyond the item id, and no secrets" | S not run |
| Spans | deferred to week 2 by owner decision (2026-10-08) | deferred |
| Frontend (PlanSettings add-on controls) | **not done**: the app repo is outside this API lane. Contract it maps to: `addonSchema` (`grant.statement`, `unit_price_usd`), `addonChangeResponseSchema` (`status: "pending"`) | not met this week |
| Real-API evidence (sandbox Checkout item add, proration, schedule release) | collected in NEW-A-17 (needs a running real API and Stripe sandbox); Stripe is the fake gateway in every test | deferred |

## Mutation results (hand-applied, reverted)

Run against `billing-addons.service.spec.ts`, `addon-grant.spec.ts`, `addon-items.spec.ts`, `stripe-http.addons.spec.ts`.

| Mutation | Result |
|---|---|
| seat refusal skipped | KILLED (2 tests) |
| reconcile always bumps the version | KILLED |
| reconcile has no unchanged short-circuit | KILLED |
| grant without prompt slots | KILLED |
| extra_project price 49.00 -> 49.50 | KILLED |
| extractor accepts non-USD | KILLED |
| cap boundary `>` -> `>=` | KILLED |
| member boundary `>` -> `>=` | KILLED |
| override not respected on removal | KILLED (after the first test was found not to discriminate and was fixed) |
| no proration on update | KILLED |
| removal drops nothing from the next phase | KILLED |
| reconcile reads closed rows (`AND active_until IS NULL` dropped) | SURVIVED the unit specs — a scripted client cannot see SQL semantics. Covered only by the (unrun) integration test "buying it again opens a NEW active row" |

## Decisions and known gaps (for the reviewer / owner)

1. **RESOLVED by the audit fix (contract commit, RED `ab787a1`, impl `fdf92e2`): `quantity` on POST is the DESIRED TOTAL.** The owner chose neither reading before the audit; the audit allowed "quantity = desired total" or a committed intent, and the total needs no schema change. Consequences the owner/app must carry: (a) the wire meaning changed (the openapi diff tool classes it `major`); the app must send the total it wants, not an increment; (b) a total below what Stripe holds is a 409 (removal is DELETE, whole add-on); a total equal to it is a 202 no-op with no Stripe call; (c) the Stripe idempotency key is `addon-<workspace>-<kind>-<sha256(Idempotency-Key)[0:32]>`. STORY-076 in the docs hub should state this (the docs repo has no .git here; carry it over).
2. **Annual subscriptions are refused (409).** Stripe needs every item on one interval and only a monthly add-on price ($49, $15) is decided. An annual price is an owner decision.
3. **Pre-purchase price display.** `GET /billing/addons` lists only add-ons in force; a workspace with none cannot read the $49/$15 from the API before buying, which `check:no-cost-literals` needs on the control. No endpoint for it is named in the story; a catalog read is a story/contract decision.
4. **While a removal is scheduled, Stripe may refuse direct item changes** (a subscription attached to a schedule). A later POST then returns 503 `degraded` until the schedule releases. Needs sandbox confirmation (NEW-A-17); not handled specially.
5. **A scheduled removal is not visible in `GET`** (the row keeps `active_until: null` until Stripe drops the item), so `addonSchema.active_until`'s comment ("set to the period end by a removal") is not what happens. Making it so needs the resolver to honour a future `active_until` and `ux_addons_active` to allow a re-add: a schema/resolver change the story did not name. The `DELETE` response carries `effective_at`.
6. **`ConflictError`'s typed details carry no `limit`/`current`**, so the seat refusal states the figures in its message ("8 members are active but the reduced seat limit would be 7"). The integration assertion was changed from `seats.max` to that message before any run.
7. **Add-on removal of `extra_project` is not refused for projects already over the reduced limit** — the story only requires the seat refusal; excess projects are STORY-077's.
8. **Stripe product:** the inline `price_data` of a subscription item needs a Product id (only Checkout accepts `product_data`), so the gateway creates one product per kind under the fixed id `nominara_addon_<kind>` and reuses it. No catalog to keep in step with ours, but the product exists in the Stripe account.
9. **`scheduleAddonRemoval`** uses a subscription schedule (current phase to the period end unchanged, a second phase without the add-on's price, `end_behavior: release`). Request shape is unit-tested against a stubbed SDK; that Stripe accepts it is unverified until NEW-A-17.
10. No migration, no new dependency, no new vocabulary. `db:rls-generate` not applicable.

## Gate commands (worktree api-wt-d1)

| Command | Exit | Result |
|---|---|---|
| `pnpm lint` | 0 | clean |
| `pnpm typecheck` | 0 | clean (includes `test/integration/billing-addons.spec.ts`) |
| `pnpm contracts:generate` then `pnpm contracts:check` | 0 | no drift; `/billing/addons` and `/billing/addons/{kind}` present |
| `pnpm contracts:diff <integration/7day openapi> <current>` | 0 | `minor` |
| `pnpm test:unit` | 0 | 282 files passed, 1 skipped; 3392 tests passed, 1 skipped (was 3350; +42 from this story) |
| `pnpm exec vitest run` of the RED specs at `235e0ab` | 1 | 2 files failed, 0 tests ran (missing modules) |
| `test/integration/billing-addons.spec.ts` | not run | disk 6.1 GiB < 8 GiB |
| `pnpm test:isolation` | not run | no tenant table touched; known fixture crash at this tip |


## Audit fix: a retried POST charged twice (blocker 1)

| Item | Proof |
|---|---|
| Stripe applies the change, the reply is lost, the same Idempotency-Key retried: exactly one unit | `src/modules/billing/billing-addons.service.spec.ts` > "AC1 retry . Stripe applies the change and the reply is lost ..."; HTTP form in `test/integration/billing-addons.spec.ts` "AC1 retry ..." (NOT RUN, see below) |
| Key derived from workspace + Idempotency-Key (stable on retry, differs by key and by workspace, <= 255, key text not sent) | "AC1 retry . the Stripe key is derived ..." |
| Total already held is a no-op; a lower total is a 409 | "a total already held is a no-op", "a total below what is held is a 409" |
| RED | commit `ab787a1`: `vitest run billing-addons.service.spec.ts` exit 1, 6 failed / 16 passed (the old additive arithmetic and the random key) |
| GREEN | 22 passed / 22. `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test:unit` 0 (282 files passed, 3396 tests) |
| Mutations on the fix | random key restored: 1 failed. Always-call-Stripe: 1 failed. 409 guard removed: 1 failed. Additive total restored: 5 failed. All killed |

## Audit items 2 and 3: NOT DONE, blocked on disk

`df -h /System/Volumes/Data` showed 4.7 GiB free at the start and 6.3 GiB at the end; the hard rule is 8 GiB before testcontainers. So the STORY-075b / 076b integration specs, `stripe-subscriptions`, `stripe-webhook`, the M1-M6 mutation re-run, `pnpm test:isolation` and `pnpm test:isolation:breakers` were NOT run on this tip. Nothing was removed to make room (the free space is not this lane's to reclaim). Needed: the owner frees disk (>= 8 GiB), then run those suites, record RED against the parent of `c279f9b` / `28ea168`, and re-apply M1-M6.


## Integration run (2026-10-08, disk 12 GiB free at start; closes "NOT RUN" above)

Two defects in `test/integration/billing-addons.spec.ts` itself (written without a database) were found by the first run and fixed in the spec; no implementation change:
1. `subIdOf` used the first 8 hex of a UUIDv7 workspace id (a millisecond timestamp prefix), so two workspaces created in one test collided on `ux_subscriptions_stripe` (3 tests, webhook 500). Now `sub_<full workspace id>`.
2. The "cannot write one for B" assertion inserted via `SELECT ... FROM subscriptions WHERE workspace_id = B` under A's context; RLS hid the row, so a zero-row INSERT succeeded and the `rejects` was vacuous. It now inserts B's real subscription id (read as superuser) so RLS WITH CHECK must refuse it.

| Run | Exit | Result |
|---|---|---|
| `billing-addons.spec.ts` first run | 1 | 3 failed / 28 passed (defect 1), then 1 failed / 30 (defect 2) |
| `billing-addons.spec.ts` + `stripe-subscriptions` + `stripe-webhook` + `entitlement-resolution` after the fixes | 0 | 4 files, 134 tests passed |
| RED (integration): `BillingAddonsController` removed from `billing.module.ts` (temporary, reverted), same spec | 1 | 21 failed / 10 passed (the 10 are reconciler/webhook rows that need no endpoint). The spec could not be run at `235e0ab` itself: it needs the fake gateway methods added in `c279f9b` |
| Mutation: `reconcile` locks closed rows (`AND active_until IS NULL` dropped, `billing-addons.service.ts` FOR UPDATE read) | 1 | KILLED by "AC1 . an add-on that left Stripe's subscription is closed..." (the mutation that survived the unit specs) |
| `pnpm lint` | 0 | clean |
| `pnpm typecheck` | 0 | clean |
| `pnpm test:unit` | 0 | 282 files passed, 1 skipped; 3396 passed, 1 skipped |
| `pnpm test:isolation`, `pnpm test:isolation:breakers` | 1 | still crash in `seedTenant` (`three-tenant-fixture.ts:149`, `support_grants` INSERT, check violation 23514) at this tip even though `3871292` (d-admin-2) is an ancestor. Not caused by this story (no tenant table touched; `subscription_addons` has its generated policy). Tenant isolation is proved in the integration spec under `nominara_app` (3 tests, passing). Disk fell to 7.4 GiB during these runs; no further testcontainers runs were started |

Still deferred: real-API / Stripe sandbox evidence (NEW-A-17), the PlanSettings frontend (app repo), spans (week 2).


## Audit round 3 (2026-10-08): scheduled-removal freeze, and the two money guards

Disk check before any testcontainers run: `df -h /System/Volumes/Data` = 5.4 GiB free (< 8 GiB). By the hard rule NO integration/isolation suite was run in this round. Everything below marked UNRUN needs a run once the owner frees disk.

### Finding 1 (major): a scheduled removal froze phase 2

Rule chosen: REFUSE. `add()` returns 409 ("an add-on removal is scheduled for the end of this billing period ...") when the fetched subscription has a `schedule` attached and the request would change Stripe (total > held). A total already held stays a no-op (retry safety). The other option (rebuild phase 2 on every change) depends on whether Stripe accepts direct item changes on a scheduled subscription, which is unverified: that is NEW-A-17 (sandbox), and must be confirmed before go-live. Known cost of this rule: the schedule stays attached through the period end AND the one-cycle phase 2, so add-on purchases are refused for up to two cycles after a DELETE; the owner may prefer rebuild-phase-2 once the sandbox answer is known. Second DELETE compounding is not a problem under this rule (no add can intervene, so `keep(next.items)` is still correct).

| Criterion | Proof |
|---|---|
| DELETE kind A then POST kind B: assert what phase 2 contains | `billing-addons.service.spec.ts` "AC13 . DELETE extra_project then POST extra_seat {3} is a 409 ...": one removal recorded, POST 409, no `changeAddonQuantity`, no second schedule write (phase 2 untouched) |
| no schedule: POST proceeds | "AC13 . with no schedule attached the same POST goes through" |
| held total retry is still a no-op under a schedule | "AC13 . a total already held is still a no-op ..." |
| RED | `1b7ebc3`: `vitest run billing-addons.service.spec.ts` exit 1, 1 failed / 24 passed ("promise resolved ... instead of rejecting") |
| GREEN | fix commit after it; `vitest run src/modules/billing src/lib/billing` exit 0, 152 passed |
| Sandbox confirmation | NEW-A-17, NOT collected (needs the real API/sandbox) |
| Integration form of the DELETE-then-POST case | NOT written: `FakeStripeGateway` does not model schedules; unit proof only |

### Finding 2 (major): the two guards now have tests

| Guard | Test | Mutant | Result |
|---|---|---|---|
| workspace row lock in `add()` | unit "lock . add() takes the workspace row lock BEFORE the subscription read and the Stripe fetch"; integration "audit . concurrent POSTs with DISTINCT Idempotency-Keys ..." (12 parallel POSTs, totals 2..13, Stripe applies after 50 ms; asserts exactly one create, one line, final quantity 13) | lock `SELECT ... FOR UPDATE` deleted from `add()` (scratch edit, restored; `git diff` clean after) | unit: KILLED (1 failed / 26 passed, exit 1). Integration: UNRUN |
| reconcile filter `AND stripe_subscription_id = $2` | unit "reconcile filter . an event for an OLD subscription id matches no live row" (a DB whose only live subscription is `sub_current`); integration "audit . a late event for an OLD, ended subscription leaves the CURRENT subscription's add-ons active" | replaced by `$2::text IS NOT NULL` | unit: KILLED (1 failed / 26 passed, exit 1). Integration: UNRUN |

Honest limit: the unit lock test proves ORDER (lock before the read and the fetch), not mutual exclusion; only the integration concurrency test proves the latter, and it has never been executed. The unit reconcile test is a scripted DB that models the filter, so it too is weaker than the integration case. Neither integration test has been run, so their assertions (notably the 200 on the old-subscription webhook, and that 12 parallel requests fit the harness pool) are unverified, and the integration mutant runs are owed.

### Gates (exit codes)
`pnpm lint` 0 · `pnpm typecheck` 0 · `pnpm test:unit` 0 (282 files passed, 1 skipped; 3401 passed, 1 skipped). `test:integration` / `test:isolation`: not run (disk).
