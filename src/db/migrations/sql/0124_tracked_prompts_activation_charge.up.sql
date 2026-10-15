-- STORY-046 AC3 - the prompt activation charge is ONCE per prompt (owner decision 2026-10-14), so "this prompt has been
-- activated before, and what it cost" has to outlive pause, archive and re-activation. Two columns on the row, because the
-- fact belongs to the prompt and the free-allowance count (first `prompts.free_at_creation` generated prompts a PROJECT ever
-- activates) is read from the same place.
--
--   first_activated_at  timestamptz  NULL until the prompt first leaves 'archived'; never cleared afterwards
--   activation_credits  integer      what that first activation cost: 0 inside the free allowance, the price beyond it
--
-- EXPAND phase: one nullable column and one NOT NULL column with a constant default (metadata-only on Postgres 11+).
-- BACKFILL: every generated prompt that is known to have run was activated under the old rule, which charged nothing,
-- so it is marked activated-and-free. That is what keeps an existing project from being asked to pay for prompts it
-- already runs, and from receiving a second free ten. "Known to have run" is
--   (a) not archived today, or
--   (b) archived but with evidence of having run: an answer_captures row for the prompt (an archived prompt that was
--       captured must have been active). Soft-deleted rows are included - the free count does not give a slot back.
-- An archived prompt with no such evidence is genuinely a never-activated candidate and is left NULL: guessing "yes"
-- gives credits away, but guessing "no" for one that ran charges a customer for a prompt they already had, so (b) is
-- what keeps the guess honest. Manual prompts are never stamped: they are never charged and never spend the allowance.
ALTER TABLE tracked_prompts
  ADD COLUMN first_activated_at timestamptz,
  ADD COLUMN activation_credits integer NOT NULL DEFAULT 0 CONSTRAINT ck_prompts_activation_credits CHECK (activation_credits >= 0);

UPDATE tracked_prompts tp
   SET first_activated_at = tp.created_at
 WHERE tp.generation_source = 'generated' AND tp.first_activated_at IS NULL
   AND (tp.status <> 'archived'
        OR EXISTS (SELECT 1 FROM answer_captures ac WHERE ac.workspace_id = tp.workspace_id AND ac.prompt_id = tp.id));
