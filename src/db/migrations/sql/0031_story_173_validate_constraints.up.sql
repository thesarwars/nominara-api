-- STORY-173 — validate the CHECKs 0030 added NOT VALID.
--
-- A separate file, so a separate transaction, on purpose: VALIDATE CONSTRAINT
-- takes SHARE UPDATE EXCLUSIVE (reads and writes continue) only when it is not
-- inside the transaction that took ACCESS EXCLUSIVE for the DROP / ADD
-- CONSTRAINT in 0030. Numbered 0031 because 0028 (STORY-169) and 0029
-- (STORY-170) are claimed by unmerged branches and 0030 is this story's.
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_last_strong_auth_method_check;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE user_credentials VALIDATE CONSTRAINT user_credentials_revoked_reason_check;
