-- Reverse of 0021.
--
-- THE BACKFILL IS LOSSY AND THAT IS UNAVOIDABLE: restoring NOT NULL needs a
-- value for every row written since, and the only value available is the
-- wrong one this migration removed. A row whose brand_present is NULL has
-- never been parsed; `false` will claim the brand was absent from it. Rolling
-- back re-introduces the defect by definition — there is no honest value to
-- put in a column that cannot express "unknown".
UPDATE answer_captures SET brand_present = false WHERE brand_present IS NULL;

ALTER TABLE answer_captures ALTER COLUMN brand_present SET DEFAULT false;
ALTER TABLE answer_captures ALTER COLUMN brand_present SET NOT NULL;

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
    EXECUTE format('ALTER TABLE %s ALTER COLUMN brand_present SET DEFAULT false', child);
  END LOOP;
END $$;
