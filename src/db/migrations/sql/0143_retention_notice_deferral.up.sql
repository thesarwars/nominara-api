-- STORY-077 slice B (EC-41, data-model.md §7) — a plan change that SHORTENS retention is announced, and the first purge under
-- the shorter window is deferred past the notice.
--
--   * workspaces.retention_purge_not_before: while it is in the future the nightly retention sweep (workers/rollup/retention.ts)
--     expires nothing for that workspace, and the read paths (modules/tracking/raw-retention.ts) hide nothing by window. NULL is
--     the ordinary state: no deferral. It can only DELAY a purge; no code path reads it to purge more.
--   * downgrade_notices.kind gains 'retention_shortened': the notice rides the existing recorded-email outbox
--     (migration 0134: idempotent per (workspace, request, kind), sent by the signed tenant job billing.downgrade_notice with
--     no transaction open, re-enqueued by the hourly relay), so there is exactly one send path.
--
-- Expand only: one nullable column, and a CHECK widened to a superset (every existing row satisfies it). The constraint keeps
-- the name Postgres gave it in 0134 (`<table>_kind_check`). downgrade_notices is small (the relay deletes rows after 30 days);
-- on a large table add the CHECK NOT VALID and VALIDATE it afterwards.
ALTER TABLE workspaces ADD COLUMN retention_purge_not_before timestamptz;

COMMENT ON COLUMN workspaces.retention_purge_not_before IS
  'STORY-077 slice B — the retention sweep expires nothing for this workspace until this instant (a shortened retention window is announced 14 days ahead; the first purge is day 15). NULL = no deferral.';

ALTER TABLE downgrade_notices DROP CONSTRAINT downgrade_notices_kind_check;
ALTER TABLE downgrade_notices
  ADD CONSTRAINT downgrade_notices_kind_check
  CHECK (kind IN ('paused', 'resumed', 'retention_shortened'));
