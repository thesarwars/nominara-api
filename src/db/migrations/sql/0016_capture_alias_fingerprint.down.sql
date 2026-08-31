-- STORY-032 rollback. Dropping the fingerprint returns L3 to the state where
-- an alias-set change cannot be detected, so every short-circuit decision
-- falls back to recomputing — slower and more expensive, never incorrect.

ALTER TABLE answer_captures DROP COLUMN IF EXISTS alias_fingerprint;
