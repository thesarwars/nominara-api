-- Reverse of 0030. A value the narrower CHECKs reject cannot stay in the
-- table, so the rows that carry one are normalised first: a strong-auth stamp
-- by OTP is cleared (the session simply reads as not recently re-authenticated,
-- which fails closed), and an 'address_proved' session revocation stays revoked
-- but is recorded as 'logout'. The credential column is dropped; a credential
-- revoked by the first proof stays revoked (revoked_at is untouched).
UPDATE sessions
   SET last_strong_auth_at = NULL, last_strong_auth_method = NULL
 WHERE last_strong_auth_method = 'email_otp';
UPDATE sessions SET revoked_reason = 'logout' WHERE revoked_reason = 'address_proved';

ALTER TABLE user_credentials DROP CONSTRAINT user_credentials_revoked_reason_check;
ALTER TABLE user_credentials DROP COLUMN revoked_reason;

ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout', 'reuse_detected')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_revoked_reason_check;

ALTER TABLE sessions DROP CONSTRAINT sessions_last_strong_auth_method_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_last_strong_auth_method_check
  CHECK (last_strong_auth_method IN ('webauthn')) NOT VALID;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_last_strong_auth_method_check;
