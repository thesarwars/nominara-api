-- Lossy: the provenance columns (rule_code, review flag and reason, explanation, derivation, typed preconditions) are dropped with
-- their data; the patch content, hash and reversal stay. Immutability is lifted.
DROP TRIGGER IF EXISTS patches_immutable ON patches;
DROP FUNCTION IF EXISTS app.reject_patch_update();
ALTER TABLE patches
  DROP CONSTRAINT IF EXISTS ck_patches_preconditions_array,
  DROP CONSTRAINT IF EXISTS ck_patches_review_reason;
ALTER TABLE patches
  DROP COLUMN IF EXISTS preconditions,
  DROP COLUMN IF EXISTS derivation,
  DROP COLUMN IF EXISTS explanation,
  DROP COLUMN IF EXISTS review_reason,
  DROP COLUMN IF EXISTS requires_human_review,
  DROP COLUMN IF EXISTS rule_code;
