-- ============================================================================
-- STORY-073 — what the ledger needs before a replay can verify a wallet.
--
-- `billing-and-credits.md`: "The `after` columns make the wallet
-- reconstructable by replay. A nightly job asserts the wallet equals the
-- ledger sum and pages on any mismatch." Three things stood between the
-- table as STORY-072 left it and a replay anyone should trust.
-- ============================================================================

-- ─────────────────────────── 1. REPLAY ORDER ───────────────────────────
--
-- ⚠ `occurred_at` IS NOT THE ORDER THE WALLET SAW. It defaults to `now()`,
-- which in Postgres is TRANSACTION START TIME — the moment the statement
-- block opened, before it ever waited on the `credit_wallets` row lock. Two
-- concurrent movements on one workspace therefore carry timestamps in
-- whatever order their transactions BEGAN, which is routinely the opposite
-- of the order the balance actually moved in:
--
--   T1 BEGIN 12:00:00.000 ── waits 40ms on the wallet lock ── reserves
--   T2 BEGIN 12:00:00.010 ── takes the lock first          ── reserves
--
-- Replayed by `occurred_at`, T1's movement is applied to a balance T2 had
-- not yet touched, and every after-column from there on looks wrong. A
-- verifier that pages a human at 3am must not page them for that.
--
-- `seq` is drawn from a sequence at INSERT time, and every ledger insert
-- happens inside the same transaction as, and AFTER, the wallet statement it
-- describes — so the value is drawn with the wallet row lock already held.
-- A second transaction cannot reach its own insert until the first commits
-- and releases, which makes sequence order and wallet order the same order.
-- That invariant is the one thing replay rests on; `test/unit/credits/
-- replay.spec.ts` and the integration suite both pin it.
--
-- GENERATED ALWAYS, not BY DEFAULT: nothing should be able to choose its own
-- position in a billing history. A restore that genuinely must preserve
-- values uses OVERRIDING SYSTEM VALUE and says so.
--
-- ⚠ THIS REWRITES THE TABLE. Adding an identity column assigns a value to
-- every existing row, which Postgres cannot do without a full rewrite under
-- ACCESS EXCLUSIVE. `credit_ledger` is empty in every environment today, so
-- it is free now and would not be later. It does not match additive-guard's
-- `add column … not null` pattern — an identity column is implicitly NOT
-- NULL without the words — so the guard would not have caught it; this note
-- is here instead of an annotation the guard does not ask for.
-- ⚠ AND THE "EMPTY" PRECONDITION IS ENFORCED, NOT ASSERTED IN A COMMENT.
-- On a populated table Postgres assigns identity values in HEAP SCAN ORDER,
-- which is insertion order only by accident and never after an UPDATE-free
-- table has been vacuumed and refilled. The verifier would then replay a
-- confident, wrong order and page a human about a wallet that is fine. If
-- this migration ever runs behind a release that wrote ledger rows, it must
-- stop and make someone think about how to order them.
DO $$
DECLARE
  existing bigint;
BEGIN
  SELECT count(*) INTO existing FROM credit_ledger;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'cannot add credit_ledger.seq: % row(s) already exist. Identity values would be assigned in heap order, '
      'which is not the order the wallet moved in, and the nightly verifier would page on a correct wallet. '
      'Backfill seq from a deliberate ordering first, then apply this migration with the guard removed knowingly.',
      existing
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

ALTER TABLE credit_ledger ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX ix_credit_ledger_ws_seq ON credit_ledger (workspace_id, seq);

-- ─────────────────── 2. A CORRECTION MUST CARRY ITS REASON ───────────────────
--
-- §6 rule 4: "an unreconcilable discrepancy is resolved by a human-authored
-- `adjustment` entry with a reason — the system never silently rewrites a
-- balance." `reason` has been nullable since 0002, so an adjustment with no
-- explanation was representable, and a balance nobody can account for is the
-- exact outcome the rule exists to prevent.
--
-- Enforced here rather than only in `adjustCredits`'s TypeScript signature
-- because the database is the last caller. A psql session, a future service,
-- a data migration — none of them go through the function.
--
-- ⚠ NOT `btrim(reason) <> ''`, WHICH IS WHAT THIS SAID FIRST. `btrim`'s
-- default trim set is the SPACE CHARACTER ALONE, so a reason of one tab, one
-- newline, or one non-breaking space passed the database check while
-- `adjustCredits` rejected all three (JS `trim()` covers every Unicode
-- space). The check meant to backstop the function was strictly weaker than
-- it, for exactly the callers — psql, a data migration — that skip the
-- function. The second-engineer review probed it and all three were accepted.
--
-- The class below is `[[:space:]]` plus the Unicode spaces it does not cover
-- in a UTF-8 database, which is what makes it agree with `trim()`. It is a
-- backstop against an empty gesture, not a judge of whether the reason is a
-- good one; no constraint can be that.
-- ⚠ `reason IS NOT NULL` IS LOAD-BEARING AND WAS BRIEFLY DROPPED. A CHECK
-- passes when its expression evaluates to NULL, so
-- `entry_type <> 'adjustment' OR reason ~ '…'` is `false OR NULL` = NULL for
-- an adjustment with no reason at all — accepted. Tightening the pattern
-- from `btrim` to a regex quietly re-opened the very hole the constraint was
-- added to close, and the test that had been written for the original
-- version is what caught it.
ALTER TABLE credit_ledger ADD CONSTRAINT ck_credit_ledger_adjustment_reason
  CHECK (entry_type <> 'adjustment'
         OR (reason IS NOT NULL
             AND reason ~ '[^[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'));

-- ──────────────────────── 3. THE SIGN CONVENTION ────────────────────────
--
-- Replay has to know which way each entry moves the balance, and there are
-- two coherent ways to say it: sign the amount, or imply the direction from
-- the type. This table does the second — a `commit` of 40 and a `grant` of
-- 40 are both written as 40 — and that is fine right up until `adjustment`,
-- which is the one type whose direction is not implied by anything.
--
-- So: every other type is a POSITIVE MAGNITUDE, and `adjustment` carries a
-- SIGNED, NON-ZERO delta. Written down as a constraint because a convention
-- that lives only in a replay function is a convention the next writer will
-- break, and the failure mode is a balance that reconciles to the wrong
-- number rather than to an error.
--
-- `commit` is the one exception to "positive": `commitCredits` accepts a
-- consumed amount of 0 (a priced action that ended up consuming nothing
-- still has to release its reservation through the commit path), and the
-- entry recording that is honestly 0.
ALTER TABLE credit_ledger ADD CONSTRAINT ck_credit_ledger_credits_sign
  CHECK (
    CASE entry_type
      WHEN 'adjustment' THEN credits <> 0
      WHEN 'commit'     THEN credits >= 0
      ELSE credits > 0
    END
  );

-- ──────────────── 4. A BALANCE MOVEMENT NAMES ITS BUCKET ────────────────
--
-- `included` and `purchased` are separate balances with different lifetimes
-- — included resets at `cycle_end`, purchased rolls over twelve months — so
-- an entry that moves one of them without saying which cannot be replayed at
-- all. `reserve`/`commit`/`release` are exempt: they move `reserved`, or
-- they draw from the expiring bucket first by rule, and in both cases the
-- bucket is derived rather than chosen.
-- ⚠ A BICONDITIONAL, NOT AN IMPLICATION. The first version only required a
-- bucket where one is needed, and still ACCEPTED one on `reserve`, `commit`
-- and `release` — where, by this very comment's reasoning, the bucket is
-- derived rather than chosen. `replayLedger` ignores it on those three, so a
-- row could claim a charge came out of `purchased` when the statement drew
-- from `included`: invisible to replay, and visible to anyone reading the
-- ledger. A column that is sometimes authoritative and sometimes decorative
-- is worse than one that is always absent.
ALTER TABLE credit_ledger ADD CONSTRAINT ck_credit_ledger_bucket_scope
  CHECK ((entry_type IN ('grant', 'purchase', 'expire', 'refund', 'adjustment')) = (bucket IS NOT NULL));


-- ───────────────── 5. APPEND-ONLY AT THE GRANT LEVEL TOO ─────────────────
--
-- `credit_ledger` has been append-only by TRIGGER since 0002 and by nothing
-- else. `audit_log` got both: migration 0005 revokes UPDATE and DELETE from
-- the runtime roles and calls it "belt and braces alongside the
-- reject_update_delete trigger", citing security-and-tenancy.md §2's "two
-- independent controls on it is proportionate". `credit_ledger` inherited
-- `SELECT, INSERT, UPDATE, DELETE` from the blanket ALTER DEFAULT PRIVILEGES
-- in that same migration and was never narrowed.
--
-- One control is one thing to get wrong. A trigger can be disabled by a table
-- owner, and `retention.ts` DOES disable this one, by design, on the erasure
-- path — so the single control has a documented off switch. STORY-073 is the
-- story that makes this table the authoritative reconstruction of every
-- wallet, which is when the second control stops being belt-and-braces and
-- starts being the point.
--
-- Nothing legitimate loses anything: the trigger already refuses every UPDATE
-- and DELETE these roles could have issued, so no working code path can
-- depend on the privilege. The owner role is unaffected, which is what the
-- erasure path runs as.
REVOKE UPDATE, DELETE ON credit_ledger FROM nominara_app, nominara_worker;
