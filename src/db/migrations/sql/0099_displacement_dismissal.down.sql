-- Undo 0099. Rows are kept; only the dismissal marks are dropped (a dismissed loss reappears in the feed).
ALTER TABLE displacement_events DROP COLUMN dismissed_by;
ALTER TABLE displacement_events DROP COLUMN dismissed_at;
