-- Rollback of 0157_aux_audits_request_hash. Drops a derived hash only; the audit rows and the ledger are untouched.
ALTER TABLE aux_audits DROP COLUMN request_hash;
