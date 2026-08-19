-- STORY-019 — security-and-tenancy.md §5 "Session model" (step-up re-auth
-- line) and §7 (revocation and freshness).

-- Additive columns on the existing GLOBAL sessions table (migration 0009):
-- records the most recent strong (WebAuthn) re-authentication so AuthGuard's
-- existing per-request `SELECT ... FROM sessions WHERE id = $1` (STORY-017)
-- can expose it to RbacGuard's step-up check without a second lookup.
-- last_strong_auth_method's CHECK is deliberately narrow to 'webauthn' only
-- — OAuth (STORY-015) and Email OTP (STORY-016) are still Backlog. Widening
-- the CHECK when either lands is an additive follow-up migration, never a
-- rewrite of this one.
ALTER TABLE sessions ADD COLUMN last_strong_auth_at timestamptz;
ALTER TABLE sessions
  ADD COLUMN last_strong_auth_method text CHECK (last_strong_auth_method IN ('webauthn'));
