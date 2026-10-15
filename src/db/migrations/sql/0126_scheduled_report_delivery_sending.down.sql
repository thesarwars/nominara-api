-- A `sending` row cannot survive the narrower CHECK. It is, by definition, a send whose outcome was never recorded, so
-- the honest historical reading is `failed`.
UPDATE scheduled_report_deliveries
   SET status = 'failed', reason = COALESCE(reason, 'delivery did not complete (rolled back from sending)')
 WHERE status = 'sending';
ALTER TABLE scheduled_report_deliveries DROP CONSTRAINT scheduled_report_deliveries_status_check;
ALTER TABLE scheduled_report_deliveries
  ADD CONSTRAINT scheduled_report_deliveries_status_check
  CHECK (status IN ('delivered','failed','skipped_cap','logged'));
