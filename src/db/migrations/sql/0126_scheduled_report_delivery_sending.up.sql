-- Group C review (owner decision B) — a scheduled-report delivery gains a `sending` state.
--
-- ScheduledReportsService.sendNow used to await the email send INSIDE the request's transaction, holding the
-- usage_counters row lock and a pooled connection for as long as the provider took (Resend: up to ~90 s per recipient with
-- retries). The send now happens after that transaction commits, so the row is recorded `sending` in the request and
-- moved to `delivered` / `failed` / `logged` by a second short transaction once the sends are done.
--
-- Expand only: the CHECK is widened (a superset of the old one), no column, row or index changes. The constraint keeps the
-- name Postgres gave it in 0051 (`<table>_status_check`). Existing rows all satisfy the wider check.
-- (If this table grows large, add the widened CHECK `NOT VALID` and `VALIDATE CONSTRAINT` it afterwards, so the scan does not
-- run under the ACCESS EXCLUSIVE lock. Not needed while it is small.)
ALTER TABLE scheduled_report_deliveries DROP CONSTRAINT scheduled_report_deliveries_status_check;
ALTER TABLE scheduled_report_deliveries
  ADD CONSTRAINT scheduled_report_deliveries_status_check
  CHECK (status IN ('delivered','failed','skipped_cap','logged','sending'));
