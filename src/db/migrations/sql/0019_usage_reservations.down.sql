-- STORY-070 rollback. Dropping the table drops its policy and its index with
-- it. Outstanding reservations are lost, which leaves usage_counters.
-- reserved_value holding amounts nothing can now release — over-counting for
-- the rest of the cycle, which is the safe direction for a ceiling and is
-- cleared by the next period rollover.
DROP TABLE IF EXISTS usage_reservations;
