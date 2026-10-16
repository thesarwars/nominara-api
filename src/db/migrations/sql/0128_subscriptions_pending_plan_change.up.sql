-- STORY-184 — the in-app plan-change intent that survives a crash. Additive, nullable; expand phase.
--
-- pending_plan_change: the intent of POST /billing/subscription/change for this subscription (shape:
-- contracts/billing/plan-change.schema.ts, pendingPlanChangeSchema). It freezes the direction, the target plan, the
-- interval, the charge (unit_amount_cents, currency) and the Stripe idempotency key. It is committed in its own short
-- transaction BEFORE Stripe is asked, because the webhook for the change can arrive before the request commits; the
-- webhook verifies the subscription's new price against THIS intent and only when the intent's id, target plan and
-- subscription id all match what Stripe holds (a Dashboard relabel carries none of them and is refused). Cleared when
-- the target plan is adopted, or when the change is cancelled.
--
-- Same precedent as 0077's pending_checkout and 0122's pending_addon_changes: a jsonb intent on the subscription row,
-- no new table, so the existing RLS policy on subscriptions covers it.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_plan_change jsonb CHECK (pending_plan_change IS NULL OR jsonb_typeof(pending_plan_change) = 'object');
