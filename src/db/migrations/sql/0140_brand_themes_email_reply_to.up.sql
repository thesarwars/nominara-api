-- STORY-100 AC10 (owner decision 6, 2026-10-26) — the Reply-To a scheduled report's email carries. Additive, nullable;
-- expand phase. NULL means "no Reply-To": the header is omitted rather than defaulted to a person's address.
--
-- It lives on the theme row (FR-AGY-01g: one stored theme is the only source of branding), beside the existing
-- `email_from_name` display name. The CHECK is the database's half of the header-injection rule the contract and the mail
-- adapter also enforce: no control character (so no CR/LF), and the RFC 5321 maximum length. The table is small (one row
-- per theme), so the CHECK is added validated.
ALTER TABLE brand_themes
  ADD COLUMN IF NOT EXISTS email_reply_to text
    CHECK (email_reply_to IS NULL OR (char_length(email_reply_to) <= 254 AND email_reply_to !~ '[[:cntrl:]]'));
