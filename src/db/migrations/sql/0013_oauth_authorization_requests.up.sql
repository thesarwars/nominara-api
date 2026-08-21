-- STORY-015 — OAuth 2.1 + PKCE (Google, GitHub, Microsoft).
-- Spec: security-and-tenancy.md §5 "Authentication",
--       schemas/identity-and-tenancy.md "users"/"user_credentials".

-- ============================================================================
-- oauth_authorization_requests — GLOBAL (src/db/conventions.ts GLOBAL_TABLES).
-- The state parameter's server-held payload for an in-flight OAuth
-- authorization-code + PKCE flow: which provider, whether this is a login or
-- an account-link, the PKCE verifier to replay to the token endpoint, and the
-- session-binding hash that refuses a callback presenting a state issued to
-- a DIFFERENT session (security-and-tenancy.md §5 AC "state is signed,
-- single-use, short-lived, and bound to the initiating session").
--
-- code_verifier is stored PLAINTEXT, not hashed. It must be replayed
-- VERBATIM to the provider's token endpoint at callback time — a one-way
-- hash cannot reconstruct the original value, so hashing this column would
-- make the flow itself impossible, not merely less convenient. The row's
-- short TTL and single-use consumption (mirroring webauthn_challenges'
-- pattern, migration 0008) are the control here, not at-rest concealment of
-- this column.
--
-- This table has NO worker/report/portal grants — only the API role
-- (nominara_app) ever touches an in-flight OAuth authorization request; a
-- background job, the read replica, and the share-token portal have no
-- legitimate reason to read a live PKCE verifier or a session-binding hash.
-- Same grant-decision reasoning as user_credentials (migration 0005) and
-- webauthn_challenges (migration 0008): GRANT, not RLS, because RLS would
-- imply the table is reachable and merely filtered.
--
-- link_user_id is required exactly when purpose='link' (linking a provider
-- onto an already-authenticated account) and forbidden when purpose='login'
-- (a callback alone must never link — security-and-tenancy.md AC "Linking a
-- provider to an existing account requires the user to already be
-- authenticated"), enforced by ck_oauth_auth_requests_link_user below rather
-- than left to application discipline.
-- ============================================================================
CREATE TABLE oauth_authorization_requests (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text        NOT NULL CHECK (provider IN ('google', 'github', 'microsoft')),
  purpose        text        NOT NULL CHECK (purpose IN ('login', 'link')),
  link_user_id   uuid        REFERENCES users(id) ON DELETE CASCADE,
  code_verifier  text        NOT NULL,
  nonce          text,
  binding_hash   bytea       NOT NULL,
  redirect_uri   text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_oauth_auth_requests_link_user CHECK (
    (purpose = 'link' AND link_user_id IS NOT NULL) OR
    (purpose = 'login' AND link_user_id IS NULL)
  )
);
CREATE INDEX ix_oauth_auth_requests_expiry ON oauth_authorization_requests (expires_at) WHERE consumed_at IS NULL;

-- Reachable only by the auth path (nominara_app) — same grant decision as
-- user_credentials (migration 0005), webauthn_challenges (migration 0008),
-- and sessions/refresh_tokens (migration 0009). Runs after ALTER DEFAULT
-- PRIVILEGES (migration 0005) would otherwise have granted this new table
-- the blanket set.
REVOKE ALL ON oauth_authorization_requests FROM nominara_worker, nominara_report, nominara_portal;
