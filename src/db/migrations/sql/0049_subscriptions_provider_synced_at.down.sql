-- Rollback of 0049. Safe: the column is a guard only; without it a stale fetch is no longer refused.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider_synced_at;
