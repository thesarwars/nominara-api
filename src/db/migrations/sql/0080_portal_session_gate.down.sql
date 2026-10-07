-- Rollback of 0080. Drops the lookup and the lock columns; a locked token becomes unlocked (the lock is advisory state).
-- @contract-phase
DROP FUNCTION IF EXISTS app.share_token_by_hash(bytea);
ALTER TABLE share_tokens DROP COLUMN IF EXISTS locked_until, DROP COLUMN IF EXISTS failed_attempts;
