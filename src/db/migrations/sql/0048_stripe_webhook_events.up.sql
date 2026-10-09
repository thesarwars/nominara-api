-- NEW-D-2 — Stripe webhook de-duplication ledger (STORY-075 AC3, scenario 4).
-- Spec: schemas/billing-and-credits.md (subscriptions); the table itself is
-- named by the Track D plan (NEW-D-2).
--
-- GLOBAL (src/db/conventions.ts GLOBAL_TABLES), no `workspace_id`, no RLS, and
-- that is a decision rather than an omission. A delivery is deduplicated by
-- Stripe's event id BEFORE it is known which workspace (if any) it belongs to:
-- an event for an unknown subject is recorded too, so Stripe's redelivery of
-- it is a cheap no-op instead of another fetch. A tenant table could not hold
-- those rows. It holds no tenant data — an event id, its type, two timestamps.
--
-- Written in the SAME transaction as the effect it guards (the webhook
-- service), so a crash between the two cannot record an event as processed
-- whose effect was lost: both commit or neither does. `processed_at` is
-- therefore set at insert, and a row's existence MEANS the effect committed.
--
-- 30-day retention (sweepStripeWebhookEvents) — Stripe stops redelivering well
-- inside that window (up to 3 days in live mode), so a pruned id can never come
-- back as a replay.
CREATE TABLE stripe_webhook_events (
  event_id     text        PRIMARY KEY CHECK (event_id <> ''),
  type         text        NOT NULL CHECK (type <> ''),
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_stripe_webhook_events_received ON stripe_webhook_events (received_at);

-- Only the API's webhook route writes this. A worker, the read replica and the
-- share-token portal have no claim on payment-provider delivery state; same
-- grant decision as oauth_authorization_requests (migration 0013). Runs after
-- ALTER DEFAULT PRIVILEGES (migration 0005) would otherwise grant the blanket set.
REVOKE ALL ON stripe_webhook_events FROM nominara_worker, nominara_report, nominara_portal;
