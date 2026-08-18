-- STORY-014 — passkey (WebAuthn) registration and assertion.
-- Spec: security-and-tenancy.md §5, data-model.md §1-2,
--       schemas/identity-and-tenancy.md "webauthn_challenges".

-- Additive column: distinguishes a platform authenticator (e.g. a device's
-- built-in biometric sensor) from a cross-platform one (e.g. a security key)
-- at registration time. Nullable — existing (non-passkey) user_credentials
-- rows never had this, and OAuth/SAML/OIDC rows never will.
ALTER TABLE user_credentials
  ADD COLUMN authenticator_attachment text
    CHECK (authenticator_attachment IN ('platform', 'cross-platform'));

-- ============================================================================
-- webauthn_challenges — GLOBAL (src/db/conventions.ts GLOBAL_TABLES).
-- Ceremony state for an in-flight registration or assertion: the challenge
-- bytes the authenticator must sign, and the rp_id/origin the server issued
-- them under, re-checked verbatim at verify time. user_id is only set for a
-- registration ceremony (anchored to the account being enrolled) — a
-- discoverable-credential assertion ceremony doesn't know who's signing in
-- until the authenticator responds, so it's NULL there.
--
-- Single-use enforcement is an atomic claim, not a separate "used" flag
-- check-then-set:
--   UPDATE webauthn_challenges SET consumed_at = now()
--   WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
--   RETURNING *;
-- Zero rows back means already-consumed, expired, or unknown — all three
-- collapse to the same caller-visible rejection.
-- ============================================================================
CREATE TABLE webauthn_challenges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      text        NOT NULL CHECK (purpose IN ('registration', 'assertion')),
  user_id      uuid        REFERENCES users(id) ON DELETE CASCADE,
  challenge    bytea       NOT NULL,
  rp_id        text        NOT NULL,
  origin       text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_webauthn_challenges_expiry ON webauthn_challenges (expires_at) WHERE consumed_at IS NULL;

-- Reachable only by the auth path (nominara_app), same reasoning as
-- user_credentials (migration 0005): this is a grant decision, not a policy
-- one — RLS would imply the table is reachable and merely filtered, when in
-- fact nominara_worker/nominara_report/nominara_portal have no business with
-- it at all. Runs after ALTER DEFAULT PRIVILEGES (migration 0005) would
-- otherwise have granted this new table the blanket set.
REVOKE ALL ON webauthn_challenges FROM nominara_worker, nominara_report, nominara_portal;
