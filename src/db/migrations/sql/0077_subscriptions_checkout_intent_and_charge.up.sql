-- NEW-D-2 audit — a checkout intent that survives a crash, and the charge a
-- subscription was ADOPTED at. Additive, nullable; expand phase.
--
-- pending_checkout: the intent for the Checkout session most recently handed to
-- the workspace (shape: contracts/billing/pending-checkout.schema.ts). It is
-- committed in its own short transaction BEFORE Stripe is asked for a session,
-- so a request that dies after Stripe answered cannot strand a payable session
-- nobody recorded: the next checkout replays the intent's exact Stripe call (same
-- Idempotency-Key, same body) to find that session, and expires it. It freezes
-- the plan, interval, amount and currency the session was priced at. Cleared,
-- with open_checkout_session_id, when a paid subscription is adopted.
--
-- charged_*: the amount, currency and interval a Stripe subscription was
-- verified at when it was adopted (taken from the intent, else from the catalog
-- at that moment). Later webhook events are compared with THIS, not with
-- plans.monthly_price/annual_price as they are today, so a catalog price change
-- does not freeze every existing subscription. All three are set or none are.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_checkout           jsonb   CHECK (pending_checkout IS NULL OR jsonb_typeof(pending_checkout) = 'object'),
  ADD COLUMN IF NOT EXISTS charged_unit_amount_cents  integer CHECK (charged_unit_amount_cents IS NULL OR charged_unit_amount_cents > 0),
  ADD COLUMN IF NOT EXISTS charged_currency           char(3) CHECK (charged_currency IS NULL OR charged_currency ~ '^[A-Za-z]{3}$'),
  ADD COLUMN IF NOT EXISTS charged_interval           text    CHECK (charged_interval IS NULL OR charged_interval IN ('month', 'year')),
  ADD CONSTRAINT ck_subscriptions_charged_all_or_none CHECK (
    (charged_unit_amount_cents IS NULL) = (charged_currency IS NULL)
    AND (charged_unit_amount_cents IS NULL) = (charged_interval IS NULL)
  );
