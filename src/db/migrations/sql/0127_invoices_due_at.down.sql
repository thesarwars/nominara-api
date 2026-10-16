-- Undo 0127. Dropping due_at loses the recorded due date; period_end then serves as the due proxy again for rows written
-- before the service-period change, and the next Stripe redelivery rewrites the rest. No other data is touched.
ALTER TABLE invoices DROP COLUMN due_at;
