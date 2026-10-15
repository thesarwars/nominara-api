-- Rollback of 0125. The carries are derived from the ledger, so dropping them loses no record; a hold still open at
-- a roll that had a carry would thereafter settle as a plain hold (its carried credits stay in the included bucket
-- until the next roll resets them).
DROP TABLE IF EXISTS credit_hold_carries;
