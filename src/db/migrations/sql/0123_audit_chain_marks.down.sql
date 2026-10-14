-- Reverse of 0123. Drops the table with its indexes, trigger, comment and ACL.
-- LOSSY: the marks are the verifier's only memory of how long each chain was,
-- so after this the next walk accepts whatever chain it finds (tail truncation
-- and whole-chain deletion are invisible again) until marks accumulate anew.
DROP TABLE IF EXISTS audit_chain_marks;
