-- Rollback of 0164_usage_ledger_credit_ledger_idx. Drops an index only; no row is touched.
DROP INDEX IF EXISTS ix_usage_ledger_credit_ledger;
COMMENT ON COLUMN usage_ledger.credit_ledger_id IS NULL;
