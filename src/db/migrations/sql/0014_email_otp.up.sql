-- STORY-016 — email one-time codes (fallback sign-in), with enumeration
-- resistance. Spec: security-and-tenancy.md §5 "Authentication" (8-digit
-- code, 10-minute TTL, 5 attempts, Argon2id-hashed at rest, single use,
-- rate-limited 3/hour/email), §8 (Argon2id m=64MiB, t=3, p=1).

-- ============================================================================
-- email_otp_codes — GLOBAL (src/db/conventions.ts GLOBAL_TABLES).
-- One row per issued code. code_hash is Argon2id-encoded, never plaintext
-- (AC "hashed with a password-grade function at rest"). attempts increments
-- on every wrong guess against every LIVE code for the address (D3), and a
-- code that hits max_attempts is INVALIDATED
-- (invalidated_reason='attempts_exhausted'), never merely rejected — a
-- rejected-but-live code could be attacked again after a rate-limit window
-- resets. A successful verification invalidates every other outstanding
-- code for the same user (invalidated_reason='superseded').
--
-- Same grant decision as user_credentials/webauthn_challenges/sessions/
-- oauth_authorization_requests: GRANT-restricted, not RLS, because this is
-- pre-tenant-context auth-path state, not tenant data — only nominara_app
-- ever needs to read or write a live code.
-- ============================================================================
CREATE TABLE email_otp_codes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash           text        NOT NULL,
  attempts            smallint    NOT NULL DEFAULT 0,
  max_attempts        smallint    NOT NULL DEFAULT 5,
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  invalidated_at      timestamptz,
  invalidated_reason  text        CHECK (invalidated_reason IN ('attempts_exhausted', 'superseded') OR invalidated_reason IS NULL),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_email_otp_codes_invalidated_pair CHECK (
    (invalidated_at IS NULL AND invalidated_reason IS NULL) OR
    (invalidated_at IS NOT NULL AND invalidated_reason IS NOT NULL)
  )
);

-- "Live" codes for a user — not yet consumed, not yet invalidated. Backs
-- both the D3 every-live-code-increments-on-a-wrong-guess lookup and the
-- success-path invalidate-all-outstanding-codes update.
CREATE INDEX ix_email_otp_codes_live ON email_otp_codes (user_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL;

REVOKE ALL ON email_otp_codes FROM nominara_worker, nominara_report, nominara_portal;

-- ============================================================================
-- email_otp_requests — GLOBAL (src/db/conventions.ts GLOBAL_TABLES).
-- The rate-limit ledger, deliberately NOT linked to `users` — it must accept
-- addresses with no account at all, since an unknown address that never got
-- a ledger row would never be rate-limited and the 429 itself would become
-- an existence oracle (D5). Written on EVERY request regardless of whether
-- the address resolves to a user.
--
-- email_hash/source_hash are peppered hashes (OTP_EMAIL_HASH_PEPPER), never
-- the plaintext address or IP — an email address is not high-entropy, so an
-- unpeppered hash would let anyone with DB read access dictionary-attack the
-- ledger to confirm who requested a code. source_hash is nullable because
-- the request source is not always available (e.g. worker-originated
-- retries have no client IP).
-- ============================================================================
CREATE TABLE email_otp_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash   bytea       NOT NULL,
  source_hash  bytea,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_otp_requests_email_window  ON email_otp_requests (email_hash, created_at);
CREATE INDEX ix_email_otp_requests_source_window ON email_otp_requests (source_hash, created_at);

REVOKE ALL ON email_otp_requests FROM nominara_worker, nominara_report, nominara_portal;
