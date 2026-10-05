-- STORY-173 — passkey registration proves the address.
--
-- Numbered 0030 on purpose: origin/main ends at 0027, and the unmerged story
-- branches 169 (0028) and 170 (0029) have claimed the next two, so `pnpm
-- db:generate` (which numbers by file count) would have collided with 0028.
--
-- Additive only (every value already in the tables still satisfies every
-- CHECK below); no index or table changes, so nothing here touches RLS. Every
-- CHECK is added NOT VALID and then VALIDATEd: VALIDATE CONSTRAINT takes only
-- SHARE UPDATE EXCLUSIVE, so a populated `sessions` table is not held under
-- ACCESS EXCLUSIVE for a full scan the way a plain ADD CONSTRAINT would.
--
-- 1. sessions.last_strong_auth_method gains 'email_otp'. 0010 narrowed it to
--    'webauthn' "until OTP lands", saying widening it is "an additive
--    follow-up migration, never a rewrite". security-and-tenancy.md §5 names
--    both: step-up is "a fresh WebAuthn or OTP within 5 minutes". An email
--    one-time code now stamps the session it creates.
-- 2. sessions.revoked_reason gains 'address_proved'. The first successful proof
--    of an address revokes every session that predates it. Reusing 'logout' or
--    'reuse_detected' would lie in the audit trail.
-- 3. user_credentials.revoked_reason (new, nullable) — 'user' for a person's
--    own unlink/revoke, 'address_proved' for the first-proof revocation. The
--    reason is what makes the revocation DURABLE: OAuth sign-in reactivates a
--    credential revoked by the person who owns it (ux_credentials_oauth is
--    unique on (provider, subject) regardless of revoked_at), and must never
--    reactivate one revoked because the address was proved by someone else.
--    NULL on every row that exists today (reactivation behaves as before).
ALTER TABLE sessions DROP CONSTRAINT sessions_last_strong_auth_method_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_last_strong_auth_method_check
  CHECK (last_strong_auth_method IN ('webauthn', 'email_otp')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_last_strong_auth_method_check;

ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout', 'reuse_detected', 'address_proved')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_revoked_reason_check;

ALTER TABLE user_credentials ADD COLUMN revoked_reason text;
ALTER TABLE user_credentials
  ADD CONSTRAINT user_credentials_revoked_reason_check
  CHECK (revoked_reason IN ('user', 'address_proved')) NOT VALID;
ALTER TABLE user_credentials VALIDATE CONSTRAINT user_credentials_revoked_reason_check;
