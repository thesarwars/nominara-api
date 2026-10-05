-- STORY-173 — passkey registration proves the address.
--
-- Numbered 0030 on purpose: origin/main ends at 0027, and the unmerged story
-- branches 169 (0028) and 170 (0029) have claimed the next two, so `pnpm
-- db:generate` (which numbers by file count) would have collided with 0028.
--
-- Two CHECKs on the GLOBAL sessions table are widened, additively (every
-- value already in the table still satisfies them). No column, table or
-- index changes, so nothing here touches RLS.
--
-- 1. last_strong_auth_method gains 'email_otp'. 0010 narrowed it to
--    'webauthn' "until OTP lands", saying widening it is "an additive
--    follow-up migration, never a rewrite". security-and-tenancy.md §5 names
--    both: step-up is "a fresh WebAuthn or OTP within 5 minutes". An email
--    one-time code now stamps the session it creates, which is what lets a
--    person who has just proved their address add a passkey.
-- 2. revoked_reason gains 'address_proved'. The first successful proof of an
--    address revokes every session that predates it (a session minted for an
--    address nobody had proved cannot be trusted once someone does).
--    Reusing 'logout' or 'reuse_detected' would lie in the audit trail.
ALTER TABLE sessions DROP CONSTRAINT sessions_last_strong_auth_method_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_last_strong_auth_method_check
  CHECK (last_strong_auth_method IN ('webauthn', 'email_otp'));

ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout', 'reuse_detected', 'address_proved'));
