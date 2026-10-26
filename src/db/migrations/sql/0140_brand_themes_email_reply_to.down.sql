-- Drops the Reply-To. Lossy: a theme's stored reply address is forgotten and scheduled-report email goes out with no
-- Reply-To header, which is exactly how it behaved before 0140. Nothing else depends on the column.
ALTER TABLE brand_themes DROP COLUMN IF EXISTS email_reply_to;
