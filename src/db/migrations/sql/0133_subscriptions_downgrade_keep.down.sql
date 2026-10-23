-- Drops the keep choice. Lossy: a pending downgrade's recorded choice is forgotten and its cut-over falls back to the
-- default (keep the most recently active). Nothing else depends on the column.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS downgrade_keep;
