-- Nothing to reverse: validating a CHECK changes no data and the constraint
-- stays in force either way. 0030's down narrows and drops the constraints
-- themselves. (A statement is still required of every .down.sql.)
SELECT 1;
