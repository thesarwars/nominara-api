-- STORY-077 D2 — the customer's keep choice for a pending downgrade (owner approved 2026-10-20). Additive, nullable;
-- expand phase.
--
-- downgrade_keep: what PUT /billing/subscription/change/keep recorded (shape: contracts/billing/downgrade-keep.schema.ts,
-- downgradeKeepRecordSchema): {intent_id, project_ids, prompt_ids, chosen_at}. Bound to the intent it was made for
-- (pending_plan_change.id): the cut-over honours it only while adopting THAT intent, and every path that clears or
-- replaces pending_plan_change clears it too (the cancel, the cut-over, a new intent).
--
-- The pending_plan_change precedent (0128): a jsonb on the subscription row, no new table, so the existing RLS policy on
-- subscriptions covers it. One row per workspace, so the CHECK is added validated.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS downgrade_keep jsonb CHECK (downgrade_keep IS NULL OR jsonb_typeof(downgrade_keep) = 'object');
