-- NEW-D-2 — rollback of 0048_stripe_webhook_events. Safe: the ledger is a
-- de-duplication cache; dropping it re-opens redelivery of already-processed
-- events only until the handlers' own idempotence (fresh-fetch reconciliation)
-- absorbs them.
DROP TABLE IF EXISTS stripe_webhook_events;
