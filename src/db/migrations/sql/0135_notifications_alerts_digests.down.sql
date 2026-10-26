-- Rollback of 0135. Drops the read receipts (every notification reads as unread again), the email outbox (an unsent
-- email is lost; its job then finds no row and sends nothing) and the four columns. Nothing else references them.
DROP TABLE IF EXISTS notification_emails;
DROP TABLE IF EXISTS notification_reads;
ALTER TABLE usage_counters DROP COLUMN IF EXISTS warned_at_95;
ALTER TABLE workspace_members DROP COLUMN IF EXISTS digest_cadence;
DROP INDEX IF EXISTS ix_notifications_kind_recent;
DROP INDEX IF EXISTS ux_notifications_event_key;
ALTER TABLE notifications DROP COLUMN IF EXISTS event_key;
