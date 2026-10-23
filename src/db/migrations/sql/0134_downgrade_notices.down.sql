-- Rollback of 0134. Drops the recorded downgrade emails: an unsent one is lost (its job then finds no row and sends
-- nothing), which is what the inline send before 0134 did on a failure. Nothing else references the table.
DROP TABLE IF EXISTS downgrade_notices;
