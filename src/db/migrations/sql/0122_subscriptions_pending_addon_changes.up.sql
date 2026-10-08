-- STORY-076b checkpoint-3 — the add-on change intent that survives a crash.
-- Additive, nullable; expand phase.
--
-- pending_addon_changes: the intents of POST /billing/addons for this
-- subscription (shape: contracts/billing/addon.schema.ts, pendingAddonChangesSchema),
-- a map keyed by a hash of the request's Idempotency-Key. Each entry freezes the
-- kind, the units asked, the TOTAL the Stripe item is set to, and the key sent to
-- Stripe. It is committed in its own short transaction BEFORE Stripe is asked, so
-- a request that dies after Stripe applied the change (reply lost, timeout, a
-- later commit failure) leaves the record of what it asked for. The retry reads
-- the stored total and Stripe key instead of adding to what Stripe now holds,
-- which is what charged the customer twice. The service keeps at most 20 entries.
--
-- Same precedent as 0077's pending_checkout: a jsonb intent on the subscription
-- row, no new table, so the existing RLS policy on subscriptions covers it.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_addon_changes jsonb CHECK (pending_addon_changes IS NULL OR jsonb_typeof(pending_addon_changes) = 'object');
