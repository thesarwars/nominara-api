-- STORY-046 AC3 - the prompt activation charge is ONCE per prompt (owner decision 2026-10-14), so "this prompt has been
-- activated before, and what it cost" has to outlive pause, archive and re-activation. Two columns on the row, because the
-- fact belongs to the prompt and the free-allowance count (first `prompts.free_at_creation` generated prompts a PROJECT ever
-- activates) is read from the same place.
--
--   first_activated_at  timestamptz  NULL until the prompt first leaves 'archived'; never cleared afterwards
--   activation_credits  integer      what that first activation cost: 0 inside the free allowance, the price beyond it
--
-- EXPAND phase: one nullable column and one NOT NULL column with a constant default (metadata-only on Postgres 11+).
-- BACKFILL: every generated prompt that is not archived today was activated under the old rule, which charged nothing, so
-- it is marked activated-and-free. That is what keeps an existing project from being asked to pay for prompts it already
-- runs, and from receiving a second free ten. An archived prompt is left NULL: whether it was ever active is unknowable
-- from the row, and the failure mode of guessing "never" is a one-credit charge, while guessing "yes" gives credits away.
ALTER TABLE tracked_prompts
  ADD COLUMN first_activated_at timestamptz,
  ADD COLUMN activation_credits integer NOT NULL DEFAULT 0 CONSTRAINT ck_prompts_activation_credits CHECK (activation_credits >= 0);

UPDATE tracked_prompts
   SET first_activated_at = created_at
 WHERE status <> 'archived' AND generation_source = 'generated' AND first_activated_at IS NULL;
