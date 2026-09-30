-- STORY-170 — the refresh-token reuse grace window, moved from the client
-- into the API.
-- Spec: security-and-tenancy.md §5 "Session model" — "presenting a consumed
--       refresh token revokes the entire session family and raises a
--       session.reuse_detected security event". A refresh presenting the
--       token consumed by the session's OWN IMMEDIATELY-PRECEDING rotation,
--       within a short window, must instead receive the SAME successor —
--       requests racing the same rotation across tabs/instances converge on
--       one token rather than one of them revoking the session.
--
-- Single slot per session, not a column on refresh_tokens: only the ONE most
-- recent rotation is ever grace-eligible ("the immediately preceding
-- rotation" — an older, two-back token is never eligible regardless of
-- timing), so a per-session slot that the NEXT rotation unconditionally
-- overwrites is both the simplest and the correct shape — it makes "wiped on
-- the next rotation" a structural property of the single UPDATE that sets
-- it, not a separate cleanup step. sessions is already GLOBAL (conventions.ts:
-- "session identity state ... not tenant data", migration 0009's own
-- comment), and refresh()'s existing rotation already takes
-- `SELECT ... FOR UPDATE` on this exact row (session.service.ts), so no new
-- lock is introduced.
--
-- refresh_grace_successor_ciphertext is the raw successor refresh token,
-- ENVELOPE-ENCRYPTED (v1:{dek_id}:{iv}:{ct} — src/lib/crypto/envelope.ts,
-- the same AES-256-GCM format as workspace_keys) under a key DERIVED FROM
-- THE PREDECESSOR TOKEN (HKDF-SHA256, salted with the session id —
-- src/lib/auth/refresh-token.ts). The server never stores the predecessor,
-- so only a caller presenting it can open the slot: a leaked row, even with
-- every server secret, does not reveal the live successor, and a slot an
-- idle session leaves behind is inert (presenting the predecessor after the
-- window revokes the family). All three columns are nullable and additive;
-- the session's next rotation overwrites them and a reuse revocation clears
-- them.
ALTER TABLE sessions
  ADD COLUMN refresh_grace_predecessor_hash text,
  ADD COLUMN refresh_grace_successor_ciphertext text,
  ADD COLUMN refresh_grace_expires_at timestamptz;

COMMENT ON COLUMN sessions.refresh_grace_predecessor_hash IS
  'refresh_tokens.token_hash of the token consumed by this session''s most recent rotation (STORY-170, security-and-tenancy.md §5). Grace-eligible only until refresh_grace_expires_at; overwritten by the next rotation; cleared by a reuse revocation.';
COMMENT ON COLUMN sessions.refresh_grace_successor_ciphertext IS
  'Envelope-encrypted (v1:{dek_id}:{iv}:{ct}) raw value of the successor refresh token minted by the rotation refresh_grace_predecessor_hash names, under a key derived from that predecessor token (HKDF-SHA256, salted with the session id) — openable only by a caller presenting the predecessor. The value a grace-window reuse returns instead of revoking. Overwritten by the next rotation; cleared by a reuse revocation.';
COMMENT ON COLUMN sessions.refresh_grace_expires_at IS
  'When this session''s refresh-token reuse grace window closes (REFRESH_TOKEN_GRACE_WINDOW_MS after the rotation that set refresh_grace_predecessor_hash). A reuse presented at or after this instant revokes the family and raises session.reuse_detected, exactly as a non-grace-eligible reuse already does.';
