-- STORY-014 — rollback of 0008_identity_authenticator_attachment.

DROP TABLE IF EXISTS webauthn_challenges;

ALTER TABLE user_credentials DROP COLUMN IF EXISTS authenticator_attachment;
