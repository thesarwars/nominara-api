-- Undo 0124. The columns record when a prompt was first activated and what it cost; dropping them loses the once-per-prompt
-- memory (a re-activated prompt would be charged again) but no customer data, and the credit_ledger keeps every debit.
ALTER TABLE tracked_prompts DROP COLUMN activation_credits, DROP COLUMN first_activated_at;
