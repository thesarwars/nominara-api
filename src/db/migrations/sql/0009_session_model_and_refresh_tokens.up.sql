-- STORY-017 — session model, rotating refresh with reuse detection.
-- Spec: security-and-tenancy.md §5 "Session model", this story's own
--       Implementation Decisions.

-- ============================================================================
-- sessions — GLOBAL (src/db/conventions.ts GLOBAL_TABLES). No workspace_id:
-- a `sid` stays stable across a workspace switch (the access token's `ws`
-- claim changes, the session identity does not), so this is user identity
-- state, not tenant data — same reasoning as user_credentials. Revocation is
-- the entire deny-list mechanism: AuthGuard checks `revoked_at IS NULL` by
-- `sid` on every request, which also serves as the `jti` deny-list, since
-- revoking the session invalidates every jti ever minted under it.
-- ============================================================================
CREATE TABLE sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at     timestamptz,
  revoked_reason text        CHECK (revoked_reason IN ('logout', 'reuse_detected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessions_user_id ON sessions (user_id);

-- ============================================================================
-- refresh_tokens — GLOBAL, one row per issued refresh-token INSTANCE (never
-- overwritten in place), so reuse detection can check full history rather
-- than only the immediately-previous token: a token stolen two or more
-- rotations back is still caught the moment it is ever presented again,
-- because its own row's consumed_at is already set.
--
-- token_hash is SHA-256 of the opaque high-entropy random value the client
-- holds (security-and-tenancy.md §8: "high-entropy random tokens use
-- SHA-256") — the raw value is never stored. The partial unique index
-- enforces "one active (unconsumed) refresh token per session" at the
-- database level, so a rotation race can never leave two simultaneously
-- live refresh tokens for the same session.
-- ============================================================================
CREATE TABLE refresh_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE UNIQUE INDEX ux_refresh_tokens_token_hash ON refresh_tokens (token_hash);
CREATE UNIQUE INDEX ux_refresh_tokens_one_active_per_session ON refresh_tokens (session_id) WHERE consumed_at IS NULL;

-- Reachable only by the auth path (nominara_app) — same grant decision as
-- user_credentials (migration 0005) and webauthn_challenges (migration
-- 0008): nominara_worker/nominara_report/nominara_portal have no business
-- with session or refresh-token state at all. Runs after ALTER DEFAULT
-- PRIVILEGES (migration 0005) would otherwise have granted these two new
-- tables the blanket set.
REVOKE ALL ON sessions, refresh_tokens FROM nominara_worker, nominara_report, nominara_portal;
