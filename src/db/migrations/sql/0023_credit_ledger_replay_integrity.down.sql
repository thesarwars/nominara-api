-- Reverse of 0023.
--
-- Unlike 0022's, this one CAN run: it removes constraints and a column that
-- carry no information the ledger rows themselves do not already carry. No
-- row is destroyed and no amount is reinterpreted — `seq` only ever recorded
-- an order that was already implicit in the wallet's own serialisation, and
-- the three CHECKs only ever refused writes that should not have happened.
--
-- ⚠ WHAT IT DOES COST is the ability to verify. With `seq` gone, replay has
-- only `occurred_at` to order by, and that is transaction-start time rather
-- than wallet order (see the up migration). Rolling this back therefore
-- turns the nightly verifier from "asserts the wallet equals the ledger" into
-- "asserts it, unless two movements raced" — so the verifier must be stopped
-- with it, not left running to page on races. `credit-verify.ts` refuses to
-- run at all when the column is absent, rather than quietly degrading.

-- The grants 0005's blanket ALTER DEFAULT PRIVILEGES gave every table. Put
-- back so the rollback leaves the role set exactly as it found it — even
-- though the append-only trigger makes the privilege unusable either way.
GRANT UPDATE, DELETE ON credit_ledger TO nominara_app, nominara_worker;

DROP INDEX ix_credit_ledger_ws_seq;

ALTER TABLE credit_ledger DROP CONSTRAINT ck_credit_ledger_bucket_scope;
ALTER TABLE credit_ledger DROP CONSTRAINT ck_credit_ledger_credits_sign;
ALTER TABLE credit_ledger DROP CONSTRAINT ck_credit_ledger_adjustment_reason;

-- @contract-phase
ALTER TABLE credit_ledger DROP COLUMN seq;
