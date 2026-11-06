-- STORY-067 — rollback of 0163_task_verifications. LOSSY: the verification schedule and its audit trail are forgotten, so a completed
-- task's pending re-measurement is never taken. Nothing else references the table; the measured impacts already written onto
-- milestones (`milestones.measured_impact`) are untouched.
DROP TABLE IF EXISTS task_verifications;
