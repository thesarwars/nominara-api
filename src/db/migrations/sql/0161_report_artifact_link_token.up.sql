-- STORY-180 (owner decision 54 (3), option 3B) - a stored, revocable token for the emailed report link.
--
-- A scheduled report's file over 8 MiB is not attached; the email carries a 7-day link. A URL presigned with role credentials dies
-- with the session, so the link is an API route (GET /v1/report-links/{workspaceId}/{token}) that checks THIS token on every click
-- and then redirects to a fresh 15-minute presign. The token itself is never stored: only its SHA-256, which is all the lookup needs.
--
--   link_token_hash  sha256 of the token in the email. NULL = no link has been issued for this artifact (every artifact that is
--                    attached or only shown on screen). Unique where set, so a hash names one artifact.
--   link_revoked_at  set to revoke the link. The route answers a revoked token with 401 `token_revoked` ("This link was revoked."); an
--                    unknown or expired token is still the neutral 404.
--
-- The link's lifetime is the artifact's own expires_at (7 days from the build), so no third timestamp.
--
-- Expand-only: two nullable columns and a partial index on an existing tenant table. No new table, so no RLS change: the existing
-- ws_isolation policy on report_artifacts already covers both columns.
ALTER TABLE report_artifacts
  ADD COLUMN link_token_hash bytea,
  ADD COLUMN link_revoked_at timestamptz;

CREATE UNIQUE INDEX ux_report_artifacts_link_token ON report_artifacts (link_token_hash) WHERE link_token_hash IS NOT NULL;
