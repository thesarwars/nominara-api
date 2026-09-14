-- ============================================================================
-- STORY-091 — `answer_captures.brand_present` becomes NULLABLE.
--
-- THE COLUMN COULD NOT TELL "NOT PARSED YET" FROM "THE BRAND WAS ABSENT",
-- and `NOT NULL DEFAULT false` made every unparsed row claim the second.
--
-- This is not a new finding. `src/lib/capture/l1-exact-hash.ts` records it
-- from a second-engineer review: a suppressed L1 row "was not 'unscored
-- pending re-match'; it was unscoreable, permanently, while `brand_present
-- NOT NULL DEFAULT false` presented it to any future aggregation as 'the
-- brand was absent'." The capture stage writes the row; STORY-135's parse
-- stage fills the scores afterwards, so between the two there is a window in
-- which the default is simply wrong.
--
-- STORY-091 puts that column on the wire — §6's cell renders `①44%🟢` — and
-- the matrix exists precisely to keep "we could not ask" apart from "the
-- engine did not mention you". Publishing a defaulted `false` would collapse
-- the distinction the grid is built to preserve, one level below the one
-- STORY-034 already protects.
--
-- The three siblings (`brand_rank_position`, `sov`, `sentiment_label`) were
-- already nullable and needed nothing. `citation_count` and
-- `owned_citation_count` have the same `NOT NULL DEFAULT 0` shape and the
-- same latent problem; they are NOT on the matrix cell and are left alone
-- rather than widened into this story.
-- ============================================================================

-- Recursive on a partitioned parent: Postgres drops the constraint on every
-- leaf partition too.
ALTER TABLE answer_captures ALTER COLUMN brand_present DROP NOT NULL;

-- The DEFAULT is not recursive the same way. A partition created by
-- `CREATE TABLE ... PARTITION OF` copies the parent's default AT CREATION and
-- keeps its own copy, so the parent alone is not enough — every existing leaf
-- would keep writing `false`. Same shape as migration 0007's DO block.
ALTER TABLE answer_captures ALTER COLUMN brand_present DROP DEFAULT;

DO $$
DECLARE
  child regclass;
BEGIN
  FOR child IN
    SELECT c.oid::regclass
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'answer_captures' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER COLUMN brand_present DROP DEFAULT', child);
  END LOOP;
END $$;
