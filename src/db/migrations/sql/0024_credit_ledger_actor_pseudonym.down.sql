-- Reverse of 0024.
--
-- ⚠ IT DESTROYS INFORMATION AND CANNOT PUT IT BACK. Dropping the column
-- discards every erased actor's pseudonym, and the pseudonym is one-way —
-- there is nothing to recompute it from, because the `users` row it was
-- derived from was anonymised at erasure time and the id is gone.
--
-- Rolling back therefore takes the ledger from "we know these entries were
-- all the same person, and not who" to "we know nothing", permanently. That
-- is a real loss for the invoice-dispute window §7 keeps these rows for, and
-- it is annotated rather than silently allowed: `additive-guard.ts` refuses
-- a DROP COLUMN on a populated table without the marker below, which is
-- exactly the conversation this rollback should force.

-- @contract-phase
DROP INDEX ix_credit_ledger_actor_pseudonym;
ALTER TABLE credit_ledger DROP CONSTRAINT ck_credit_ledger_actor_exclusive;
ALTER TABLE credit_ledger DROP COLUMN actor_pseudonym;
