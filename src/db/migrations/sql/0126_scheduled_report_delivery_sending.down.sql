-- A `sending` row cannot survive the narrower CHECK. It is, by definition, a send whose outcome was never recorded, so
-- the honest historical reading is `failed`.
--
-- FORCE ROW LEVEL SECURITY: scheduled_report_deliveries is ENABLE + FORCE (0051) with its policy only TO nominara_app /
-- nominara_worker / nominara_report. In production nominara_owner (NOSUPERUSER, NOBYPASSRLS; README G-4) runs this file, and
-- under FORCE even the owner is subject to the policies, which it matches none of: the UPDATE below would touch ZERO rows,
-- and re-adding the CHECK would then fail on every leftover `sending` row. (The local superuser bypasses RLS and hides it.)
-- Same pattern as 0124: the owner is exempt while the table is not forced, so FORCE is lifted for the rewrite and restored
-- straight after, in this one transaction, so no other session ever sees the table unforced.
ALTER TABLE scheduled_report_deliveries NO FORCE ROW LEVEL SECURITY;

UPDATE scheduled_report_deliveries
   SET status = 'failed', reason = COALESCE(reason, 'delivery did not complete (rolled back from sending)')
 WHERE status = 'sending';

ALTER TABLE scheduled_report_deliveries FORCE ROW LEVEL SECURITY;

-- (On a large table add the CHECK `NOT VALID` and `VALIDATE CONSTRAINT` it afterwards, so the scan does not run under the
-- ACCESS EXCLUSIVE lock. Not needed here: the table is small.)
ALTER TABLE scheduled_report_deliveries DROP CONSTRAINT scheduled_report_deliveries_status_check;
ALTER TABLE scheduled_report_deliveries
  ADD CONSTRAINT scheduled_report_deliveries_status_check
  CHECK (status IN ('delivered','failed','skipped_cap','logged'));
