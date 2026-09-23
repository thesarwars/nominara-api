-- STORY-151 — reverse of 0026.
DROP INDEX IF EXISTS ix_subscriptions_unvouched;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider;
