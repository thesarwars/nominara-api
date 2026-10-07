-- Rollback of 0075. Safe: without the column a second checkout simply no longer expires the first.
ALTER TABLE subscriptions DROP COLUMN IF EXISTS open_checkout_session_id;
