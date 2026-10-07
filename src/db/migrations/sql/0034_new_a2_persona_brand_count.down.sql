-- Reverse of 0034. A brand-count value the narrower CHECK rejects cannot stay,
-- so it is cleared to NULL (the persona only drives UI defaults) before the
-- original CHECK is restored; the skipped flag is dropped.
UPDATE users SET persona_volume_band = NULL WHERE persona_volume_band IN ('one', '2_5', '6_20', 'gt_20');
ALTER TABLE users DROP CONSTRAINT users_persona_volume_band_check;
ALTER TABLE users
  ADD CONSTRAINT users_persona_volume_band_check
  CHECK (persona_volume_band IN ('lt_1k', '1k_10k', '10k_100k', 'gt_100k'));
ALTER TABLE users DROP COLUMN persona_skipped;
