-- NEW-A-2 (decision O5) — GET/PATCH /v1/me persists the onboarding persona.
--
-- users.persona_volume_band was specified as lt_1k|1k_10k|10k_100k|gt_100k,
-- but the onboarding question is "how many brands will you track", answered
-- one|2_5|6_20|gt_20. Expand phase: the CHECK now accepts BOTH vocabularies
-- (every existing row still satisfies it); the API writes only the new one.
-- Dropping the old values is a later contract phase, once no row carries one.
--
-- users.persona_skipped records that the person dismissed the question,
-- which is not the same as never having been asked (all three persona_*
-- columns NULL and persona_skipped false). Nullable with a default of false
-- rather than NOT NULL: the additive guard treats a NOT NULL add on a populated
-- table as a contract-phase step, and the service reads NULL as false.
--
-- `users` has no workspace_id and no RLS: nothing here touches a policy. The
-- CHECK is NOT VALID (instant catalog change); 0035 validates it in its own
-- transaction so the scan does not run under this file's ACCESS EXCLUSIVE.
ALTER TABLE users DROP CONSTRAINT users_persona_volume_band_check;
ALTER TABLE users
  ADD CONSTRAINT users_persona_volume_band_check
  CHECK (persona_volume_band IN ('lt_1k', '1k_10k', '10k_100k', 'gt_100k', 'one', '2_5', '6_20', 'gt_20')) NOT VALID;

ALTER TABLE users ADD COLUMN persona_skipped boolean DEFAULT false;
