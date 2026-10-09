-- NEW-D-1 audit — stale-fetch guard for Stripe reconciliation (STORY-075 AC4).
--
-- The instant at which the Stripe fetch behind the row's last reconciliation
-- STARTED. Inside the locked transaction the webhook handler skips a write whose
-- fetch started earlier than this, so a fetch taken before a newer event's commit
-- cannot overwrite it. NULL = never reconciled from Stripe. Additive, nullable.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_synced_at timestamptz;
