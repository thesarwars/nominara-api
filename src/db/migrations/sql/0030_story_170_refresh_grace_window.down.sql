-- 0030_story_170_refresh_grace_window: reverse of the up migration.
ALTER TABLE sessions
  DROP COLUMN IF EXISTS refresh_grace_predecessor_hash,
  DROP COLUMN IF EXISTS refresh_grace_successor_ciphertext,
  DROP COLUMN IF EXISTS refresh_grace_expires_at;
