-- NEW-D-2 checkpoint-1 — at most one payable Checkout session per workspace.
--
-- The Stripe Checkout session most recently handed to the workspace and not yet
-- settled. Opening another checkout expires this one at Stripe first, so two
-- tabs (or a retry) cannot leave two payable sessions and a double charge. NULL
-- = none outstanding. Cleared when a paid subscription is adopted. Additive,
-- nullable; the workspace row lock serialises the read-expire-replace.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS open_checkout_session_id text
  CHECK (open_checkout_session_id IS NULL OR open_checkout_session_id <> '');
