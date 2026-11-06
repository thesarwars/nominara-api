-- 0164_usage_ledger_credit_ledger_idx: STORY-073 AC9. `usage_ledger.credit_ledger_id` now links each cost row to the run's
-- commit entry, and the ledger read/export sums the rows linked to each entry. Partial: most rows (free runs, embeds) carry
-- no link. No column is added or changed; expand-only and additive.
CREATE INDEX ix_usage_ledger_credit_ledger ON usage_ledger (workspace_id, credit_ledger_id) WHERE credit_ledger_id IS NOT NULL;
COMMENT ON COLUMN usage_ledger.credit_ledger_id IS
  'STORY-073 AC9: the COMMIT credit_ledger entry this cost row belongs to (same workspace, reference_type run/capture_run, tool_run, aux_audit), set when the row is recorded; NULL when the reference has no commit (a free scheduled run). No foreign key (credit_ledger is append-only and partitioned). An entry''s realised internal cost = credit_ledger.internal_cost_usd (rows that pre-dated the commit) + SUM(quantity * unit_cost_usd) of the rows linked here.';
