-- Rollback of 0144_retention_deferred_windows. LOSSY only for a deferral in flight: the sweep then honours the deferral
-- (0143) with no windows recorded, which is the old behaviour of expiring nothing for the workspace until the date.
ALTER TABLE workspaces DROP COLUMN retention_deferred_rollups_days;
ALTER TABLE workspaces DROP COLUMN retention_deferred_raw_days;
