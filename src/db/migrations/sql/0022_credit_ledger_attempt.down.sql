-- Reverse of 0022 — AND IT REFUSES, DELIBERATELY.
--
-- ⚠ THIS ROLLBACK CANNOT BE PERFORMED WITHOUT REWRITING BILLING HISTORY.
-- Dropping `attempt` collapses every retry of one request key onto a single
-- row, and the unique index that comes back refuses the duplicates. Any
-- workspace that has retried a priced action after a failure has two
-- `reserve` rows under one key, and one of them would have to be destroyed
-- for this to complete.
--
-- Which one is a billing decision, not one a migration should take.
--
-- An earlier version of this file tried a `DELETE` keeping the earliest row
-- per key. The second-engineer review found it could never execute:
-- `credit_ledger` carries a `reject_update_delete` trigger and the statement
-- fails with SQLSTATE 25006, "credit_ledger is append-only". So the rollback
-- was already a refusal — just an accidental one, naming the trigger instead
-- of the decision, and succeeding only when there was nothing to collapse.
--
-- Disabling the trigger to make the DELETE work would authorise a migration
-- to silently rewrite a ledger, which is exactly what §6 rule 4 says the
-- system must never do: "an unreconcilable discrepancy is resolved by a
-- human-authored `adjustment` entry with a reason."
--
-- So it refuses out loud. To roll back, a human must first reconcile every
-- multi-attempt family against the wallet and record the outcome as
-- `adjustment` entries, then remove this guard knowingly.
DO $$
DECLARE
  families bigint;
BEGIN
  SELECT count(*) INTO families
    FROM (
      SELECT workspace_id, entry_type, idempotency_key
        FROM credit_ledger
       GROUP BY workspace_id, entry_type, idempotency_key
      HAVING count(*) > 1
    ) multi;

  IF families > 0 THEN
    RAISE EXCEPTION
      'cannot roll back 0022: % request key(s) have more than one attempt recorded. '
      'Collapsing them would destroy ledger rows, which this system never does silently. '
      'Reconcile each family against credit_wallets and record the outcome as adjustment '
      'entries first, then remove this guard knowingly.', families
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

DROP INDEX ix_credit_ledger_attempts;

DROP INDEX ux_credit_ledger_idem;
CREATE UNIQUE INDEX ux_credit_ledger_idem
  ON credit_ledger (workspace_id, entry_type, idempotency_key);

ALTER TABLE credit_ledger DROP CONSTRAINT ck_credit_ledger_attempt_scope;
ALTER TABLE credit_ledger DROP COLUMN attempt;
