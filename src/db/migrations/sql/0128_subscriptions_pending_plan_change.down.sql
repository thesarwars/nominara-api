-- Drops the plan-change intent. Lossy by nature: a change whose Stripe call was applied but whose webhook has not yet
-- been reconciled can no longer be recognised, so that webhook would be refused as a relabel. Roll back only with no
-- plan change in flight and no downgrade scheduled (cancel it first: DELETE /billing/subscription/change).
ALTER TABLE subscriptions DROP COLUMN IF EXISTS pending_plan_change;
