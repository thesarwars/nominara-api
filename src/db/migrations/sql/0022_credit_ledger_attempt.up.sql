-- ============================================================================
-- STORY-072 — `credit_ledger.attempt`, so a retry's ledger key is not a
-- STRING the client can forge.
--
-- ⚠ THE `#` SUFFIX WAS REACHABLE FROM THE WIRE. STORY-072 gave a request key
-- a family of reserve entries — `K`, `K#2`, `K#3` — one per genuine attempt
-- after a released one. `idempotencyKeySchema` is
-- `z.string().min(1).max(255)` and permits ANY character, `#` included, so a
-- client key of `job#2` landed in the namespace the guard had reserved for
-- its own second attempt at `job`.
--
-- The second-engineer review reproduced both directions inside one
-- workspace:
--
--   DENIAL — a customer posting their own key `job#2` was refused with "this
--   request already completed and was charged", having never made a request.
--
--   MONEY — a retry of `job` was handed the live reservation belonging to
--   `job#2`, and its commit closed someone else's hold. The second seat's
--   own settlement then found its reservation already committed.
--
-- Intra-workspace rather than cross-tenant — the lookup does filter on
-- `workspace_id` — but Business carries twenty seats and Enterprise is
-- uncapped, and `scan#1` / `job#3` are ordinary client key conventions.
--
-- THE ATTEMPT IS A DISTINCT FACT AND NOW HAS A COLUMN. Overloading the key
-- string was the mistake; a client cannot write a column.
-- ============================================================================

-- `ADD COLUMN … NOT NULL DEFAULT` matches additive-guard.ts's
-- `add column … not null` pattern and passes today only because
-- `credit_ledger` is empty, so `isPopulated` is false. The operation is
-- genuinely safe on PG 18 — a DEFAULT means no table rewrite — but if this
-- migration is ever re-sequenced behind a release that writes ledger rows,
-- CI will reject it and it will need a `-- @contract-phase` marker.
ALTER TABLE credit_ledger ADD COLUMN attempt smallint NOT NULL DEFAULT 1
  CONSTRAINT ck_credit_ledger_attempt CHECK (attempt >= 1);

-- ⚠ AND ONLY A RESERVATION HAS ATTEMPTS. Widening the unique index below
-- would otherwise weaken it for every entry type that does not retry: two
-- `purchase` rows under one Stripe idempotency key became representable,
-- which is a duplicate credit grant. The old index made that impossible and
-- a comment saying "those types always use attempt 1" is a convention, not a
-- guarantee — `appendLedgerEntry` takes `attempt` as a parameter, so any
-- future caller can vary it.
--
-- This constraint is what keeps the claim true for STORY-076, which will
-- write `purchase` rows long after anyone remembers this migration.
ALTER TABLE credit_ledger ADD CONSTRAINT ck_credit_ledger_attempt_scope
  CHECK (attempt = 1 OR entry_type IN ('reserve', 'commit', 'release'));

-- The dedupe now keys on (workspace, type, key, attempt). For every entry
-- type that has no attempts — grant, purchase, refund, expire, adjustment —
-- `attempt` stays 1 and the uniqueness is exactly what it was.
DROP INDEX ux_credit_ledger_idem;
CREATE UNIQUE INDEX ux_credit_ledger_idem
  ON credit_ledger (workspace_id, entry_type, idempotency_key, attempt);

-- Reading one request key's whole family is the guard's hot path: it asks
-- "is one of this key's reservations still open" on every priced request.
CREATE INDEX ix_credit_ledger_attempts
  ON credit_ledger (workspace_id, idempotency_key, entry_type);
