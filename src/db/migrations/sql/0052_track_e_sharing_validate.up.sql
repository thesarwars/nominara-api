-- NEW-E-1 — validate the share_tokens scope_tabs CHECK that 0051 added NOT
-- VALID. A separate file (separate transaction) on purpose, as 0031 is for 0030.
ALTER TABLE share_tokens VALIDATE CONSTRAINT share_tokens_scope_tabs_check;
