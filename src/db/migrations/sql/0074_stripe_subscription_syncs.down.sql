-- Rollback of 0074. Safe: the marks are an ordering guard only; without them a
-- stale fetch is no longer refused (the webhook's idempotence still holds).
DROP TABLE IF EXISTS stripe_subscription_syncs;
