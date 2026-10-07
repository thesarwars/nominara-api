-- NEW-D-5 audit — validate the ck_support_ttl_max CHECK that 0085 added NOT VALID.
-- A separate file (separate transaction) on purpose, as 0052 is for 0051.
ALTER TABLE support_grants VALIDATE CONSTRAINT ck_support_ttl_max;
