-- Restoring NOT NULL requires a value for every existing NULL, and there is
-- no honest one — which is the whole reason the column changed. Rows written
-- while the column was nullable are backfilled to 0 ONLY to satisfy the
-- constraint on the way down, and that value is wrong in the way the up
-- migration describes.
UPDATE metric_daily SET sentiment_score = 0 WHERE sentiment_score IS NULL;
ALTER TABLE metric_daily ALTER COLUMN sentiment_score SET DEFAULT 0;
ALTER TABLE metric_daily ALTER COLUMN sentiment_score SET NOT NULL;
