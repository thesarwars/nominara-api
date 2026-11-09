-- STORY-098 — rollback of 0169_share_token_email_codes. LOSSY but harmless: outstanding sign-in codes are forgotten, so a visitor who was
-- mid-sign-in asks for a new one. Nothing else references the table.
DROP TABLE IF EXISTS share_token_email_codes;
