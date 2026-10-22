-- STORY-048 AC7 (owner decision 2026-10-22) — a bounded window for an inconclusive re-verification. Additive,
-- nullable; expand phase. No new table, no RLS change: the existing domain_verifications policy covers the column.
--
-- inconclusive_since: when the CURRENT unbroken run of inconclusive checks began on a method that was verified at the
-- time (an inconclusive result is a failure of OUR resolver to answer, which must not de-verify the fleet in one night).
-- Set by the first inconclusive result, kept by the ones after it, cleared by any conclusive result (success or
-- failure). When INCONCLUSIVE_GRACE_MS (src/lib/verification/transition.ts) has elapsed since it, the method is treated
-- as lost through the ordinary loss path, so a domain that stopped verifying cannot keep full scope for ever.
ALTER TABLE domain_verifications
  ADD COLUMN IF NOT EXISTS inconclusive_since timestamptz;
