-- STORY-096 - rollback of 0204. LOSSY: the stored user agents are forgotten, and a session revoked with 'user_revoked' stays revoked but is recorded as 'logout'
-- (the narrower CHECK cannot hold the new value).
UPDATE sessions SET revoked_reason = 'logout' WHERE revoked_reason = 'user_revoked';
ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('logout', 'reuse_detected', 'address_proved'));
ALTER TABLE sessions DROP CONSTRAINT sessions_user_agent_check;
ALTER TABLE sessions DROP COLUMN user_agent;
