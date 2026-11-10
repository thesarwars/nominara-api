-- Owner decision 96(a), 2026-11-10 (STORY-195 AC5) - a per-member sentiment-alerts setting. NULL means ON, which is every existing member's
-- behaviour today; FALSE stops alert.negative_spike reaching that member by email and in the inbox. Additive: a nullable column with no
-- default, so no row is rewritten and no existing member's alerts change. workspace_members is already a tenant table (RLS), so no policy changes.
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS sentiment_alerts_enabled boolean;

COMMENT ON COLUMN workspace_members.sentiment_alerts_enabled IS
  'Owner decision 96(a) - NULL = on (the default); FALSE = this member is not sent alert.negative_spike (email or inbox).';
