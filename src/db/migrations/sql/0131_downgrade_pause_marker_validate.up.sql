-- STORY-077 slice A — validate the three CHECKs 0130 added NOT VALID. A separate file (separate transaction) on purpose,
-- as 0086 is for 0085: VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue during the scan.
ALTER TABLE projects VALIDATE CONSTRAINT ck_projects_paused_by_downgrade_from;
ALTER TABLE projects VALIDATE CONSTRAINT ck_projects_paused_by_downgrade;
ALTER TABLE tracked_prompts VALIDATE CONSTRAINT ck_tracked_prompts_paused_by_downgrade;
