-- STORY-098 (owner decision 71 b) — allowed-email-domain sign-in for share links. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- A share token that carries `allowed_email_domains` mails a six-digit code to the visitor's address and mints the portal session only
-- when the code comes back. One row per issued code:
--   email_hash   peppered HMAC of the normalised address (the OTP pepper, src/lib/auth/email-otp.ts). The address itself is never stored:
--                the row has to answer "is this code for this address?" and nothing else.
--   code_hash    Argon2id of the code, never the code. Six digits is a small space, so the controls are the 10-minute life (expires_at),
--                the attempt budget (max_attempts = 5, then the code is invalidated, not merely refused) and the per-token / per-address
--                issue cap the service enforces under the token's row lock.
--   consumed_at  single use. A new code for the same (token, address) supersedes the live ones (invalidated_reason = 'superseded').
--
-- Bound to ONE token by a composite (workspace_id, share_token_id) key, like share_token_views (0081): a code for one link cannot
-- verify another, and a code row cannot name another tenant's token. Tenant-scoped, NOT portal-readable (the portal role holds no policy,
-- so under FORCE it sees nothing). The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0163 precedent).
CREATE TABLE share_token_email_codes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  share_token_id      uuid        NOT NULL,
  email_hash          bytea       NOT NULL,
  code_hash           text        NOT NULL,
  attempts            smallint    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        smallint    NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  invalidated_at      timestamptz,
  invalidated_reason  text        CHECK (invalidated_reason IN ('attempts_exhausted', 'superseded')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_share_token_email_codes_invalidated_pair CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL)),
  CONSTRAINT share_token_email_codes_token_fkey
    FOREIGN KEY (workspace_id, share_token_id) REFERENCES share_tokens (workspace_id, id) ON DELETE CASCADE
);

-- The verify path: the live codes of one (token, address).
CREATE INDEX ix_share_token_email_codes_live
  ON share_token_email_codes (share_token_id, email_hash) WHERE consumed_at IS NULL AND invalidated_at IS NULL;
-- The issue cap: codes issued to one (token, address) in the last hour.
CREATE INDEX ix_share_token_email_codes_issued
  ON share_token_email_codes (share_token_id, email_hash, created_at);

COMMENT ON TABLE share_token_email_codes IS
  'STORY-098 (decision 71 b) — one-time sign-in codes for share links with allowed email domains. Hashed code, peppered address hash, 10-minute life, 5 attempts. Tenant-scoped; not portal-readable.';

ALTER TABLE share_token_email_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_token_email_codes FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'share_token_email_codes' AND policyname = 'ws_isolation_share_token_email_codes'
  ) THEN
    CREATE POLICY ws_isolation_share_token_email_codes ON share_token_email_codes
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
