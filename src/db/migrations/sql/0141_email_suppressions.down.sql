-- STORY-178 — rollback of 0141_email_suppressions. LOSSY: the suppression list is forgotten, so an address that bounced or
-- complained is mailed again until its provider reports it again. Nothing else references the table.
DROP TABLE IF EXISTS email_suppressions;
