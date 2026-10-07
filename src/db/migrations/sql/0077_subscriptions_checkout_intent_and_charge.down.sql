-- Drops the intent and the frozen charge. Lossy by nature: a subscription then
-- falls back to the catalog price for its plan check, and an intent whose
-- session was never recorded can no longer be recovered.
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS ck_subscriptions_charged_all_or_none,
  DROP COLUMN IF EXISTS pending_checkout,
  DROP COLUMN IF EXISTS charged_unit_amount_cents,
  DROP COLUMN IF EXISTS charged_currency,
  DROP COLUMN IF EXISTS charged_interval;
