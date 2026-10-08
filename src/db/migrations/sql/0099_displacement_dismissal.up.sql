-- NEW-C-5: a person can dismiss a displacement and restore it (STORY-092 scenario 15, "reversible and recorded").
-- EXPAND phase: two nullable columns, no default, no backfill; every existing row stays "not dismissed".
-- `acknowledged_at` is NOT reused: it means "seen", dismissal means "set aside", and the feed treats them differently.
-- `dismissed_by` is a plain uuid (the actor), like `tasks.completed_by`; the audit log carries the durable record.
ALTER TABLE displacement_events ADD COLUMN dismissed_at timestamptz;
ALTER TABLE displacement_events ADD COLUMN dismissed_by uuid;
