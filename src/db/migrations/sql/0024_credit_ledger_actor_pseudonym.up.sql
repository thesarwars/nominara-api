-- ============================================================================
-- STORY-073 AC13 — an erased actor stays DISTINGUISHABLE in the accounting
-- record, without staying identifiable.
--
-- `data-model.md` §7: on an individual erasure request, "audit and
-- credit-ledger actor IDs pseudonymised under legitimate-interest and
-- accounting-records retention".
--
-- ⚠ WHAT HAPPENS TODAY IS NOT PSEUDONYMISATION, IT IS ERASURE OF THE ACTOR.
-- `retention.ts` sets `actor_id = SYSTEM_ACTOR_ID` on every one of the
-- person's rows. Rows are retained, and the actor is not — after two people
-- are erased you cannot tell their spend apart, you cannot tell either from
-- an entry the system genuinely caused, and a row claiming
-- `actor_type = 'user'` with the system actor's id against it is internally
-- contradictory.
--
-- That matters for this table more than for most. §7 keeps these rows for
-- the invoice-dispute window, and a dispute asks who authorised a charge.
-- "The system" is not an answer to that question; it is the absence of one.
--
-- ⚠ AND THE HASH CANNOT GO IN `actor_id`, which is why this is a column and
-- not a smarter UPDATE. `actor_id uuid REFERENCES users(id)` — a
-- pseudonymised value has no `users` row to point at, so writing one there
-- fails the foreign key. The FK is worth keeping: it is what stops a live
-- ledger naming a user who does not exist.
--
-- So: `actor_id` goes NULL, and the pseudonym carries what is left of the
-- identity — deterministic, one-way, and groupable within the workspace.
-- `pseudonymiseWorkspaceId` in src/lib/crypto/pseudonymise.ts is the same
-- construction, already used for the audit export.
-- ============================================================================

ALTER TABLE credit_ledger ADD COLUMN actor_pseudonym uuid;

-- ⚠ THE TWO ARE MUTUALLY EXCLUSIVE, and the constraint is what makes
-- "pseudonymised" a state the database can express rather than a convention
-- the erasure function happens to follow. A row carrying both would be a row
-- that was pseudonymised and still names the person.
ALTER TABLE credit_ledger ADD CONSTRAINT ck_credit_ledger_actor_exclusive
  CHECK (NOT (actor_id IS NOT NULL AND actor_pseudonym IS NOT NULL));

-- Grouping one erased person's spend back together is the whole point of
-- keeping the pseudonym, and a dispute is scoped to a workspace.
CREATE INDEX ix_credit_ledger_actor_pseudonym
  ON credit_ledger (workspace_id, actor_pseudonym)
  WHERE actor_pseudonym IS NOT NULL;
