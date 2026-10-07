-- NEW-A-2 — validates the CHECK 0034 added NOT VALID, in its own transaction
-- (takes only SHARE UPDATE EXCLUSIVE).
ALTER TABLE users VALIDATE CONSTRAINT users_persona_volume_band_check;
