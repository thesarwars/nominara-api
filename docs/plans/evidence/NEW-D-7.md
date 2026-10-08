# NEW-D-7 — auto-top-up trigger: off-session charge, cap counter, an email per trigger, disabled on failure (first cut)

Lane `7day/d-usage-3`, base `integration/7day`. Migrations: none (columns, `ck_autotopup_bounded` and
`credit_purchases.source='auto_topup'` all shipped in 0002).

**STATUS: DONE for the four acceptance criteria and audit findings 1, 2, 3, 5, 6. NOT WIRED to a balance
drop: the `billing.auto_topup` queue (owner decision 4) and the cycle roll (audit finding 4) are not built,
so `trigger_active` stays `false`. See "Not met this week".**

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
| 4 | nothing resets `auto_topup_count_cycle` | NOT FIXED: there is no cycle roll anywhere in the code (STORY-075/076). Stated in the contract comment; gate: `trigger_active` stays false and nothing calls `trigger`. |
| 5 | concurrency test could not detect removing the row lock | FIXED: two interleaving tests. |
| 6 | stuck `pending` blocks forever | FIXED `3999a62` for the lock: a pending purchase older than 60 min is failed and audited (`billing.auto_topup.pending_expired`) by the next claim; a younger one still blocks. NOT done: telling the customer (decision needed, below). |

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
