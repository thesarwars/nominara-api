-- Drops the inconclusive-window marker. Lossy only in that a window in progress starts again from the next
-- inconclusive result after a re-apply; no verification state is lost.
ALTER TABLE domain_verifications DROP COLUMN IF EXISTS inconclusive_since;
