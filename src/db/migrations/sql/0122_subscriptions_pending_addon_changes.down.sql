-- Drops the add-on change intents. Lossy by nature: a retry of a POST /billing/addons
-- whose first attempt failed after Stripe applied it can no longer be recognised, so
-- it would add again. Roll back only with no add-on purchase in flight.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS pending_addon_changes;
