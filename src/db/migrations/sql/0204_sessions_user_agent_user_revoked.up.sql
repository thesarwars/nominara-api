-- STORY-096 AC4/AC7 (owner decision 100(d), 2026-11-12) - the session list and single-session revoke.
--
-- sessions.user_agent: the device and browser are parsed from this when the account lists its own sessions. The raw header is stored (truncated to 512
-- characters by the writer); no IP address is stored, by decision. "Last active" is the existing sessions.last_used_at, so nothing else is added.
-- sessions.revoked_reason gains 'user_revoked': a person ending one of their own sessions from the list. Reusing 'logout' would lie in the audit trail
-- (logout is the session ending itself). `sessions` stays a GLOBAL auth-only table: no workspace_id, no RLS, nominara_app only (conventions.ts).
ALTER TABLE sessions ADD COLUMN user_agent text;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_agent_check CHECK (user_agent IS NULL OR char_length(user_agent) <= 512) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_user_agent_check;

ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout', 'reuse_detected', 'address_proved', 'user_revoked')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_revoked_reason_check;

COMMENT ON COLUMN sessions.user_agent IS
  'The User-Agent header at sign-in and refresh, truncated to 512 characters. Parsed for the account''s own session list only; never logged. No IP is stored (STORY-096, decision 100(d)).';
