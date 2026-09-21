-- Reverse of 0025. Dropping it loses no data and breaks no constraint — the
-- verifier still works, it simply goes back to sorting every chain on every
-- nightly run, and the chunked walk goes back to re-scanning per chunk.
DROP INDEX IF EXISTS ix_audit_ws_seq;
