# NEW-D-7 — auto-top-up trigger: off-session charge, cap counter, an email per trigger, disabled on failure (first cut)

Lane `7day/d-usage-3`, base `integration/7day`. Migrations: none (columns, `ck_autotopup_bounded` and
`credit_purchases.source='auto_topup'` all shipped in 0002).

**STATUS: PARTIAL. Implemented and typechecked/linted/unit-tested. The integration spec that proves
the four acceptance criteria was WRITTEN BUT NOT RUN, because `/System/Volumes/Data` had 7 GiB free
(< the 8 GiB floor for testcontainers specs). Nothing below is claimed as passing that was not run.**

## Commits

- `0ad4fe1` contract: `disabled_reason` (optional) on `autoTopupConfigSchema`, and the trigger outcome set.
  `contracts:diff` against the previous openapi: `minor`. `contracts:check` exit 0.
- `46c1646` RED: `test/integration/auto-topup-trigger.spec.ts` (26 tests, NOT RUN) and 4 unit tests in
  `src/lib/billing/stripe/stripe-gateway.spec.ts`. The unit file was run at this commit:
  **4 failed | 21 passed, exit 1**, reason `createOffSessionPayment is not a function` / no
  `setup_future_usage` in the Checkout call. The integration RED count is unknown (see status).
- GREEN: the commit carrying this file.

## Acceptance criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | STORY-076 scenario 7: repeated firing stops at the cap; the increment is a conditional UPDATE so concurrent triggers cannot exceed it; every trigger calls the email port | `auto-topup-trigger.spec.ts`: "scenario 7 · firing repeatedly stops at the cap, and every one of those triggers was emailed"; "... concurrent triggers cannot exceed the cap: eight at once against one slot left charge exactly once"; "... with a charge still in flight ... (in_flight)"; "... threshold boundary"; "... email names the pack and amount ... owner's address is the fallback"; "no_billing_contact"; "email_failed (fail closed)". **Written, not run.** Implementation: `AutoTopupService.claim` (row lock + `UPDATE ... WHERE enabled AND count < max AND available < threshold AND NOT EXISTS pending`). |
| 2 | Scenario 9: a failed payment sets `auto_topup_enabled=false` and notifies; never retries | "scenario 9 · a payment that fails at the webhook disables ..., notifies ..., and records why"; "... never retries"; "... a redelivered failure ... notify only once"; "... a decline answered synchronously ..."; "... a failed MANUAL purchase does not touch the setting"; "... turns it back on clears the reason". **Written, not run.** Implementation: `StripeCreditPackHandler` (failed path, `source='auto_topup'`) calls `AutoTopupService.disableAfterFailure` in the webhook transaction and queues `notifyDisabled` on the new `afterCommit` list (run after COMMIT). |
| 3 | Credits land through the STORY-076a webhook path (`credit_purchases`, `source='auto_topup'`), never at trigger time | "STORY-076a path · a trigger moves no credit ..."; "... payment_intent.succeeded lands the credits ... keyed on the PaymentIntent, and a redelivery adds nothing"; "... amount differs ... credits nothing". **Written, not run.** No code in the trigger writes the ledger or a balance. |
| 4 | Needs a saved payment method from a checkout with `setup_future_usage`; without one a recorded no-op | Unit (RUN, green): "AC4 · a credit-pack Checkout saves the card for off-session use"; "AC4 · findSavedPaymentMethod answers ... only for a PaymentIntent saved with setup_future_usage=off_session". Integration (not run): "AC4 · without a saved payment method the trigger is a no-op that records why"; "... nothing to look up"; "only a manual purchase can be the reference". |
| obs | metric + redacted log | `nominara_billing_auto_topup_trigger_total{outcome}`, `_disabled_total`, `_notify_failed_total`; test "observability: ... workspace id but no address, card or customer id" (not run). |
| tenancy | isolation | "tenant isolation: triggering one workspace touches no other ..." and the `SET LOCAL ROLE nominara_app` visibility test (not run). |

## Gates (this worktree)

- `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm contracts:check` exit 0.
- `pnpm test:unit` exit 0 on rerun: 3317 passed, 0 failed (JSON reporter). The very first full run had
  ONE failing test whose name I did not capture (output was flooded by queue-worker logs); the file
  `test/unit/audit-coverage.spec.ts` that the failure excerpt pointed at passes alone twice, and two full
  reruns were green. Treat as a possible load-sensitive flake, not proven pre-existing.
- `pnpm test:integration` for `auto-topup-trigger.spec.ts`, `credit-packs.spec.ts`, `stripe-webhook.spec.ts`,
  `billing-usage-auto-topup.spec.ts`, `credit-ledger-read.spec.ts`: **NOT RUN (disk 7 GiB < 8 GiB)**. Must
  be run before merge. `test:isolation`: not run (no table or policy touched; known crash at this tip).

## Not met this week / decisions needed

- **The trigger is not wired to anything.** `AutoTopupService.trigger(workspaceId)` is complete and tested
  in isolation, but nothing calls it when a balance drops, so `trigger_active` stays `false`. A call from
  the debit path (`CreditInterceptor`) would put a Stripe lookup, an email and a charge on the request path
  (KAD-06). Needs a decision: a new `billing.auto_topup` queue in `topology.ts` (spec §4 table, signed job,
  tenant-scoped) enqueued after the reservation commits, or an accepted post-response call. Not decided here.
- A balance that stays low with no saved card writes one `billing.auto_topup.skipped` audit row per
  evaluation. Throttle it when the trigger is wired.
- The pack Checkout now ALWAYS saves the card for off-session reuse (`customer_creation=always`,
  `setup_future_usage=off_session`) for every manual purchase, not only for workspaces with auto-top-up on.
  Owner/privacy sign-off advisable.
- OpenTelemetry span: deferred to week 2 by owner decision. Real running API evidence: NEW-A-17.
- Frontend (used/cap and the disabled-with-reason state in BillingSettings): not in this API-only item;
  the API now returns `auto_topup.disabled_reason`.
- Files outside the story's literal list touched, all needed: `identity.module.ts` (export `EMAIL_SENDER`),
  `billing.module.ts`, `stripe-event-handler.ts` + `stripe-webhook.service.ts` (the `afterCommit` hook),
  `billing.service.ts` (`disabled_reason`), `test/support/fake-stripe-gateway.ts`.
