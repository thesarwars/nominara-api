# Runbook: billing money alarms

Owner: billing. Scope: the three alarms that mean a customer may have paid for
something they were not given, or paid twice. Each is an error-level log line
plus a counter, and each means a person must act: none of them self-heals.
Introduced by NEW-D-2 / STORY-075a / STORY-076a (development-workflow.md §8 DoD 11).

Every log line carries the workspace ID (never its name). Find the customer
from that ID in the Stripe dashboard through the object ids on the same line.

## 1. `nominara_billing_credit_pack_orphan_payment_total`

**Log:** `credit pack PAID for a purchase this workspace has no record of: nothing credited, reconcile or refund at Stripe`
(fields: `workspace_id`, `purchase_id`, `payment_intent_id`, `event_id`).

**Meaning.** A signature-verified webhook says a credit-pack Checkout session was
paid, but the workspace has no `credit_purchases` row with that id. The purchase
route commits its row before it asks Stripe for a session, so this should be
unreachable. If it fires, money was taken and no credits were granted.

**Severity.** S2. Page on any increment; the expected rate is zero.

**Act.**
1. Look the `payment_intent_id` up in Stripe. Confirm `metadata.workspace_id` equals the logged workspace.
2. If the purchase row exists under another workspace, the metadata was forged or mis-set: do not credit. Refund.
3. If the row is truly missing, decide with the customer: refund at Stripe, or have an operator insert the `credit_purchases` row (`status='pending'`, the pack's frozen credits and price) and replay the event from the Stripe dashboard. The handler then settles it, keyed by the PaymentIntent id, so a replay cannot credit twice.
4. Never insert a ledger row by hand.

## 2. `nominara_billing_plan_price_mismatch_total`

**Log:** `stripe subscription price does not match its claimed plan: not reconciled`
(fields: `workspace_id`, `subscription_id`, `claimed_plan_key`, `event_id`).

**Meaning.** The price Stripe is charging on a subscription is not the price of
the plan our metadata claims, measured against the charge frozen when the
customer subscribed (or the catalog price if none was frozen). Typical cause: a
plan switch made in the Stripe billing portal, which changes the price without
rewriting our label. The reconciler refuses the write, so the tracked plan holds
and the customer is either paying for a plan they are not getting, or keeping a
plan they are not paying for.

**Severity.** S2. Triage the same day.

**Act.**
1. Open the subscription in Stripe and read the plan item's amount, currency and interval.
2. Customer wants the new plan: cancel the Stripe subscription and have them check out again through the app (a plan change is never made in the portal).
3. Customer did not: restore the original price in Stripe.
4. Either way the next event reconciles. If the alarm fires for many workspaces at once, suspect a catalog or price edit in Stripe, and stop.

## 3. `nominara_billing_double_subscription_total`

**Log:** `workspace has two live stripe subscriptions: the tracked one was kept, the other needs cancelling and refunding`
(fields: `workspace_id`, `tracked_subscription_id`, `other_subscription_id`, `event_id`).

**Meaning.** A second paid Stripe subscription went live for a workspace that
already tracks one. The reconciler keeps the tracked one and ignores the other,
so the customer is being charged twice.

**Severity.** S2. Triage the same day (the customer is being billed every cycle).

**Act.**
1. Confirm in Stripe which subscription the customer meant to keep (normally the tracked one).
2. Cancel the other (`other_subscription_id`) and refund its charge.
3. If the customer meant the other one, cancel the tracked one first, then let the other's next event adopt.

## Related, not an alarm

`nominara_billing_checkout_session_total{outcome="paid_pending"}` is a 409 shown
to a customer whose earlier checkout was paid but not yet applied. It clears when
the webhook lands. A sustained rise means webhooks are not arriving or are being
refused; check `nominara_billing_stripe_webhook_events_total` by outcome.
