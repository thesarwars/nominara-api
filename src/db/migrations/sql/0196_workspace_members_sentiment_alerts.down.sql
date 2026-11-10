-- Rollback of 0196_workspace_members_sentiment_alerts.
ALTER TABLE workspace_members DROP COLUMN IF EXISTS sentiment_alerts_enabled;
