-- STORY-053 — a copy-ready patch carries the rule that produced it, why it was made, what it was derived from, and whether a human
-- must confirm it; and a patch can no longer be edited, because "the artifact a customer copied is always reconstructable" is
-- false while an UPDATE can rewrite it.
--
-- EXPAND ONLY. Six nullable-or-defaulted columns on `patches`; no column is dropped or retyped, and the rows the optimizer
-- (STORY-059) writes later fit them (`rule_code` NULL for an alignment-session patch). `patches` is already a tenant table with its
-- RLS policy (0006); nothing about isolation changes.
--
--   rule_code              the AUX rule that produced the patch (NULL for an alignment-session patch).
--   requires_human_review  the patch touches a compliance, metric or pricing value. The copy control requires an acknowledgement.
--   review_reason          why; required whenever the flag is set.
--   explanation            what the patch does, in customer language.
--   derivation             where every derived value came from: the page's own content, or a named Nominara template.
--   preconditions          [{kind: file_hash|page_hash|file_absent, value}] - the customer's change detector, typed.
ALTER TABLE patches
  ADD COLUMN IF NOT EXISTS rule_code             text  CHECK (rule_code ~ '^AUX-R-[0-9]{3}$'),
  ADD COLUMN IF NOT EXISTS requires_human_review boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason         text,
  ADD COLUMN IF NOT EXISTS explanation           text,
  ADD COLUMN IF NOT EXISTS derivation            text,
  ADD COLUMN IF NOT EXISTS preconditions         jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE patches
  ADD CONSTRAINT ck_patches_review_reason CHECK (NOT requires_human_review OR review_reason IS NOT NULL),
  ADD CONSTRAINT ck_patches_preconditions_array CHECK (jsonb_typeof(preconditions) = 'array');

-- IMMUTABLE. Regenerating makes a new row; the original stays as it was. The ONE change allowed is the foreign key's own
-- `ON DELETE SET NULL` on finding_id (deleting a finding must not be blocked by, or destroy, the artifact a customer copied). Row
-- deletes (the project's or the alignment session's cascade, retention) are not updates and are untouched.
CREATE OR REPLACE FUNCTION app.reject_patch_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finding_id IS NOT NULL AND NEW.finding_id IS NULL
     AND (to_jsonb(NEW) - 'finding_id') = (to_jsonb(OLD) - 'finding_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a patch is immutable: regenerate to make a new row' USING ERRCODE = 'integrity_constraint_violation';
END
$$;

CREATE TRIGGER patches_immutable BEFORE UPDATE ON patches
  FOR EACH ROW EXECUTE FUNCTION app.reject_patch_update();
