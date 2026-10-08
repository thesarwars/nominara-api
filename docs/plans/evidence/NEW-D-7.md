# NEW-D-7 — auto-top-up trigger: off-session charge, cap counter, an email per trigger, disabled on failure (first cut)

Lane `7day/d-usage-3`, base `integration/7day`. Migrations: none (columns, `ck_autotopup_bounded` and
`credit_purchases.source='auto_topup'` all shipped in 0002).

**STATUS: PARTIAL, NOT DONE. The four acceptance criteria and the re-audit's findings 1-3 (stale-pending double
charge; the `enabled`, threshold and pack guards) are fixed and proven below. NOT WIRED to a balance drop: the
cycle roll and the signed `billing.auto_topup` queue handler (re-audit finding 4) are NOT built, so
`trigger_active` stays `false`, and the lane must not be marked done. See "Re-audit round 2" at the end.**

Integration specs now RAN (Docker/colima healthy; 18 GiB free at the start of the run). OpenTelemetry spans are deferred
to week 2 by owner decision: a missing span is not a failed criterion. Evidence that needs a running real API
(HTTP against a live Stripe sandbox) is collected in NEW-A-17.

## Commits (oldest first)

| sha | what | RED/GREEN |
|---|---|---|
| `0ad4fe1` | contract: `disabled_reason`, the trigger outcome set | `contracts:diff` minor, `contracts:check` exit 0 |
| `46c1646` | RED: `auto-topup-trigger.spec.ts` + 4 unit tests in `stripe-gateway.spec.ts` | unit at this sha: **4 failed / 21 passed, exit 1** (`createOffSessionPayment is not a function`, no `setup_future_usage`). The integration spec was NOT run at this sha (disk) so its RED count is unknown; it is reported as such, not invented. |
| `bdb9eef` | GREEN: `AutoTopupService`, gateway calls, webhook `afterCommit` hook | |
| `43698b3` | audit: `max_per_cycle` stated as a lifetime cap until the cycle roll | comment only |
| `7b63564` | contract: `not_in_plan` trigger outcome (additive enum value, internal, no route returns it) | `contracts:check` exit 0 |
| `386a3f2` | spec fixtures fixed + interleaving tests + RED for F2/F3/F6 | RED run at this sha: **4 failed / 30 passed (34), exit 1**, all for the stated reasons: F2 `status` was `failed` not `pending`; F3 x2 `charge_submitted` not `not_in_plan`; F6 audit rows `[]`. |
| `3999a62` | GREEN for F2/F3/F6 | 34/34 exit 0 |
| `25ae315` | RED: owner decision 4 (card saved only when auto-top-up is on) | **unit 1 failed / 25 passed, exit 1; integration 1 failed / 34 passed, exit 1** |
| `0d9e419` | GREEN for owner decision 4 | below |

Re-audit round 2 commits are listed in "Re-audit round 2" at the end of this file.

Fixture defects found when the spec first ran (it had never run): 8 of 28 failed, ALL in the test, none in the
implementation: a UUIDv7 8-char prefix collided across workspaces created in the same millisecond
(`ux_credit_purchases_pi`); the ledger assertion did not exclude the provisioning grant; the audit row redacts
`purchase_id` by design; the observability test expected `in_flight` with `max=1` where the cap correctly answers
first. None of these relaxed an assertion's meaning; the pack-unavailable test now reaches that outcome by
un-publishing the pack, because a downgrade now (correctly) answers `not_in_plan` first.

## Acceptance criteria

| # | Criterion | Proof (all in `test/integration/auto-topup-trigger.spec.ts`, RUN, exit 0) |
|---|---|---|
| 1 | Scenario 7: repeated firing stops at the cap; the increment is a conditional UPDATE so concurrent triggers cannot exceed it; every trigger calls the email port | "firing repeatedly stops at the cap, and every one of those triggers was emailed"; "concurrent triggers cannot exceed the cap: eight at once against one slot left charge exactly once"; "the cap is enforced by the claim itself: a trigger that planned before the cap was spent is refused at the UPDATE" (deterministic interleaving via `FakeStripeGateway.holdLookups`); "two triggers that both planned with nothing in flight charge once"; "threshold boundary"; "the email names the pack and amount ..."; "no_billing_contact"; "if the email cannot be sent the card is not charged". Implementation: `AutoTopupService.claim`. |
| 2 | Scenario 9: a failed payment sets `auto_topup_enabled=false` and notifies; never retries | "a payment that fails at the webhook disables ..., notifies ..., and records why"; "it never retries"; "a redelivered failure ... notify only once"; "a decline answered synchronously ..."; "a failed MANUAL purchase does not touch the setting"; "turns it back on clears the reason". |
| 3 | Credits land through the STORY-076a webhook path (`source='auto_topup'`), never at trigger time | "a trigger moves no credit ..."; "payment_intent.succeeded lands the credits ... keyed on the PaymentIntent, and a redelivery adds nothing"; "a charge whose amount differs ... credits nothing". |
| 4 | Needs a saved payment method from a checkout with `setup_future_usage`; without one a recorded no-op | Integration "AC4 · without a saved payment method ... no-op that records why"; "nothing to look up"; "only a manual purchase can be the reference". Unit (`stripe-gateway.spec.ts`): "findSavedPaymentMethod answers ... only for a PaymentIntent saved with setup_future_usage=off_session". |
| obs | metric + redacted log | `nominara_billing_auto_topup_trigger_total{outcome}`, `_disabled_total`, `_notify_failed_total`, `_pending_expired_total`; test "observability: ..." asserts the metric by outcome and that no address, card or customer id appears in any log line while the workspace id does. Span: deferred (week 2). |
| tenancy | isolation under `SET ROLE nominara_app` | "tenant isolation: triggering one workspace touches no other ..."; "the trigger itself runs as nominara_app (RLS in force) ...". `test:isolation` itself crashes at this tip (known) and no table or policy was touched. |

## Audit findings (checkpoint 3) — status

| # | Finding | Status |
|---|---|---|
| 1 | spec never ran | FIXED: ran, 34/34 (exit 0) + `credit-packs`, `stripe-webhook`, `billing-usage-auto-topup`, `credit-ledger-read`: 5 files / 148 tests exit 0. |
| 2 | timeout on the charge reopened the in-flight guard (double charge) | FIXED `3999a62`: the purchase stays `pending`; test "a provider outage on the charge leaves the purchase pending ... never charged twice". |
| 3 | kept firing after a downgrade below Growth | FIXED `3999a62`: re-asked in the verdict AND as a predicate of the claim UPDATE; two tests. |
| 4 | nothing resets `auto_topup_count_cycle` | NOT FIXED: there is no cycle roll anywhere in the code (STORY-075/076). Gate: `trigger_active` stays false and nothing calls `trigger`; the second half of the gate is now a unit test (`auto-topup-unwired.spec.ts`), see round 2. |
| 5 | concurrency test could not detect removing the row lock | FIXED: two interleaving tests. |
| 6 | stuck `pending` blocks forever | The 60-minute expiry of `3999a62` was clock-only and re-opened the double charge (re-audit finding 1). SUPERSEDED by `95222c4`: an hour-old row is expired only when Stripe says `none` / `failed`. NOT done: telling the customer (decision needed, below). |

## Mutations (each run against the full spec; source restored after each; verified applied)

| mutation | result |
|---|---|
| remove `lockWallet` in `claim` | killed: 1 failed ("two triggers that both planned ... charge once") |
| remove `NOT EXISTS pending` from the claim UPDATE | killed: same test |
| remove `count < max` from the claim UPDATE | killed: "the cap is enforced by the claim itself" |
| remove `markFailed` on a synchronous decline | killed: 1 failed |
| remove `expireStalePending` | killed: F6 test |
| replace the plan predicate in the claim UPDATE | killed: F3 "the claim re-checks the plan" |
| remove the plan check from the verdict | killed: 2 F3 tests |
| restore `markFailed` on a charge timeout | killed: F2 and F6 tests |

(The first run of the lock / pending / cap mutations SURVIVED the original 28 tests; that is why the interleaving
tests were added.)

## Gates (this worktree, tip `0d9e419`)

- `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm contracts:check` exit 0.
- `pnpm test:unit` exit 0: 277 files passed, 1 skipped; 3318 passed, 1 skipped.
- `vitest --config vitest.integration.config.ts` on `auto-topup-trigger`, `credit-packs`, `stripe-webhook`,
  `billing-usage-auto-topup`, `credit-ledger-read`: 5 files, 148 tests, exit 0.
- `test:isolation`: not run (no table or policy touched; known fixture crash at this base; the merge step runs it).

## Not met this week / decisions needed

- **Wiring (owner decision 4: a signed tenant `billing.auto_topup` queue, never on the request path) is NOT BUILT.**
  `AutoTopupService.trigger(workspaceId)` is complete but nothing enqueues it. It needs: a topology entry (the
  queue is in neither spec section 4 nor the topology pin test, so both change), a handler, a producer call
  after the reservation commits on the debit path (credit ledger = a dangerous area), and the reference-doc
  update. It was not done in the same change as the money logic so that logic could be mutation-tested alone.
- **The cycle roll** (reset of `auto_topup_count_cycle`, finding 4) does not exist; wiring without it makes the
  cap a lifetime cap. It must land with the wiring.
- Customer visibility of an expired stale purchase (finding 6, second half): audit row, metric and log only. Needs a
  decision whether to email, and whether the disabled-reason enum gains a value (a contract change).
- A balance that stays low with no saved card writes one `billing.auto_topup.skipped` audit row per evaluation;
  throttle when wired.
- Owner decision 4 changes behaviour: a workspace that buys a pack BEFORE enabling auto-top-up has no saved card,
  so its first trigger is a recorded `no_payment_method` no-op until its next purchase.
- Files outside the story's literal list touched, all needed: `identity.module.ts` (export `EMAIL_SENDER`),
  `billing.module.ts`, `stripe-event-handler.ts` + `stripe-webhook.service.ts` (the `afterCommit` hook),
  `billing.service.ts` (`disabled_reason`; `AUTO_TOPUP_MIN_PLAN` exported), `credit-packs.service.ts` and the
  gateway interface (`saveCard`), `test/support/fake-stripe-gateway.ts`.
- Frontend (used/cap and the disabled-with-reason state): not in this API-only item; the API returns
  `auto_topup.disabled_reason`.

## Re-audit round 2 (checkpoint-3 re-audit findings 1-4) — `7day/d-usage-3`

**STATUS: PARTIAL. Findings 1, 2, 3 FIXED and mutation-tested. Finding 4 (cycle roll + signed queue handler) NOT BUILT,
stopped for the decisions below. NEW-D-7 must not be marked done.**

| sha | what | RED/GREEN |
|---|---|---|
| `492c9ea` | RED: F6 rewritten (in_progress / succeeded keep it pending and charge nothing; none / failed expire it and charge once under a new purchase id; a lookup error leaves it pending; a row that settles between lookup and claim is not failed over) + the three interleaving tests for the claim guards | `auto-topup-trigger.spec.ts`: **6 failed / 37 passed (43), exit 1**. All 6 are the F6 tests, failing because the lookup is never made (`offSessionStateLookups` `[]`, `charge_submitted` where `upstream_error` was expected, row `failed` where `succeeded` expected). The guard tests (enabled / threshold / pack) PASSED at this sha: the guards already exist in the code; the missing thing was proof, so these are proven by mutation, not by a RED. |
| `95222c4` | `AutoTopupService`: `plan` reads the stale pending ids; `classifyStale` calls `gateway.findOffSessionPayment` per row OUTSIDE any transaction (KAD-06); `claim` expires only the ids Stripe said are `none` / `failed`, still guarded by `status = 'pending'`; any lookup error returns `upstream_error` before the card lookup, the claim, the email and the charge | GREEN 43/43, exit 0 |
| `cc79d71` | the `enabled` guard test also switches off while KEEPING pack/threshold/cap (the realistic PUT; the first shape was masked by the pack predicate); a KAD-06 test (no `idle in transaction` backend during the stale lookup) | 45/45, exit 0 |
| `f836e6d` | `test/unit/billing/auto-topup-unwired.spec.ts`: no production file but the three billing files may reference `AutoTopupService`, none may call `.trigger(` | 3/3 |

### Finding 1 (blocker) — acceptance
Stale pending purchase: Stripe is asked, outside the transaction; expired only on `none` / `failed`; left pending on
`in_progress`, `succeeded`, or a lookup error. Tests (`test/integration/auto-topup-trigger.spec.ts`):
"NEW-D-7 audit F6 · ... Stripe says in_progress / succeeded is NOT expired and is NOT charged again";
"... none / failed is failed and audited, and exactly one new charge is made under a NEW purchase id";
"... when Stripe cannot be asked ... it stays pending"; "... settles between the Stripe lookup and the claim ...";
"KAD-06: the Stripe lookup ... is made with no transaction open". The old F6 test that locked in the hazard is gone.
The outcome for in_progress / succeeded is `in_flight` (the claim's own NOT EXISTS pending refuses it).

### Findings 2 and 3 — acceptance
"the claim re-checks `enabled`" (x2 shapes), "the claim re-checks the threshold", "the claim re-checks the pack",
each with `gateway.holdLookups()`: no charge, no email, no purchase, `auto_topup_count_cycle` 0.
The pack test asserts `not.toBe("charge_submitted")` plus the four invariants: the outcome label for a switched pack
is `in_flight` (the claim falls through to the verdict, which finds nothing to refuse). That label is imprecise;
the contract's outcome enum has no value for "configuration changed", and adding one is a contract change nobody
asked for here.

### Mutations (full `auto-topup-trigger.spec.ts` each time, source restored with `git checkout` after each)

| mutation | result |
|---|---|
| expire every stale row whatever Stripe says | killed: 2 failed (in_progress, succeeded) |
| a lookup error expires the row | killed: 1 failed |
| `succeeded` treated as dead | killed: 1 failed |
| expire without the `status = 'pending'` guard | killed: 1 failed (settles between lookup and claim) |
| delete `AND auto_topup_enabled` from the claim | first attempt SURVIVED (the clearing PUT is also refused by the pack predicate); after the second PUT shape: killed, 1 failed |
| delete the threshold predicate | killed: 1 failed |
| `auto_topup_pack_key = $2` -> `$2::text IS NOT NULL` | killed: 1 failed |
| the stale lookup moved inside `inTx` | killed: 1 failed (KAD-06 test) |
| re-run of the older set: remove the `expireStalePending` call / `lockWallet` / `NOT EXISTS pending` / `count < max` / the claim's plan predicate | each killed (2 / 1 / 3 / 1 / 1 failed) |
| add `x.trigger(1)` to `stripe-credit-pack.handler.ts`; add an importer of `AutoTopupService` | killed (`auto-topup-unwired.spec.ts`) |

### Gates (tip `f836e6d`)
- `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm contracts:check` exit 0 (no contract changed in this round).
- `pnpm test:unit` exit 0: 278 files passed, 1 skipped; 3323 passed, 1 skipped.
- `vitest --config vitest.integration.config.ts` on `auto-topup-trigger`, `billing-usage-auto-topup`, `credit-packs`,
  `stripe-webhook`, `credit-ledger-read`: 5 files, 158 tests, exit 0.
- `test:isolation`: not run (no table, policy or migration touched; known fixture crash at this base; the merge step runs it).
- DISK: `/System/Volumes/Data` showed 6.2 GiB free when the last testcontainers batch started (the floor is 8 GiB);
  the run was launched in the same command as the check and was NOT gated on it. It finished exit 0. No further
  testcontainers run was made; flagged so the merge step does not assume headroom.
- Spans: deferred to week 2 by owner decision. Metrics/logs added: `nominara_billing_auto_topup_stale_lookup_total{state}`
  (in_progress | succeeded | failed | none | error); the existing `_pending_expired_total`; log lines carry the
  workspace and purchase id only. Verified by the existing observability test plus the lookup tests; the new
  counter itself is not asserted by name (gap, minor).
- Evidence that needs a real Stripe sandbox (does `paymentIntents.search` find an off-session intent by
  `metadata.purchase_id`, and how fresh is the index) is collected in NEW-A-17. Stripe search is eventually
  consistent; an hour-old row is far outside that window, but it has not been observed against the sandbox.

### Finding 4 — NOT BUILT, and why (stopped, not skipped)

What exists: the executable gate (`auto-topup-unwired.spec.ts`), so wiring `trigger` now fails a test instead of
breaking a prose promise. `trigger_active:false` is still a literal in the response.

What is needed, as decisions (each is outside this story's files or is a hard-boundary item):

1. **Who rolls the wallet cycle?** Nothing does. `credit_wallets.cycle_start/cycle_end` are written at provisioning
   and never advanced; the "grant refresh at cycle_end" of plans-and-entitlements section 5 / STORY-072 scenario 14
   has no code. So a counter "reset at cycle roll" has no roll to hang on. Options: (A) build the wallet roll
   (expire unused included credits, grant, advance dates, zero the counter in ONE statement), which is credit-ledger
   work and its own story; (B) count `used_this_cycle` from `credit_purchases` (source `auto_topup`,
   `created_at >= cycle_start`) so the cap follows `cycle_start` with no marker and no migration, which changes what
   the spec calls "a counter"; (C) a marker column (migration, not named by any story). Recommendation: A + B
   (B alone is correct the moment A lands). A clock-only reset is NOT acceptable: with no roll it would zero the cap on
   every claim after `cycle_end`.
2. **The `billing.auto_topup` queue.** It is in neither section 4 nor the topology pin test; the precedent is
   `ADDED_BEYOND_REFERENCE` in `test/unit/queue/topology.spec.ts` (`audit.verify`, `identity.sweep_unverified`).
   BUT `createJobProcessor` holds the job's tenant transaction open for the whole handler, and `trigger` awaits
   Stripe and the mail port: that is a transaction open across an external await (KAD-06). The existing tenant
   handlers (`capture.execute`) accept that for engine calls; for a card charge it is not acceptable. It needs a
   decision on a "verify, then release the connection" processor mode in `worker-factory.ts` (a new pattern: ADR,
   default no) or on running the three short transactions the service already uses with the job's transaction not
   held. Also the worker process has no Stripe gateway or `EMAIL_SENDER` today.
3. Required tests when it lands (both named by the audit): the cycle roll with its own test; the queue handler with a
   tampered-envelope test showing no `set_config` and no `trigger` call, with `workspaceId` taken only from the
   verified payload. `auto-topup-unwired.spec.ts` is edited in that same commit.

### Other items still open
- Customer visibility of an expired stale purchase (email, disabled-reason enum value): undecided, unchanged.
- One `billing.auto_topup.skipped` audit row per evaluation while there is no saved card: throttle when wired.
