-- Rollback of 0143_retention_notice_deferral. LOSSY: the deferral is forgotten, so the next sweep purges under the shorter
-- window at once, and recorded retention notices are deleted (an unsent one is never sent).
--
-- FORCE ROW LEVEL SECURITY: downgrade_notices is ENABLE + FORCE (0134) with its policy only TO nominara_app / nominara_worker /
-- nominara_report, so the owner running this file sees ZERO rows under FORCE and the narrower CHECK would then fail on every
-- leftover 'retention_shortened' row. Same pattern as 0126: FORCE is lifted for the rewrite and restored in this transaction.
ALTER TABLE downgrade_notices NO FORCE ROW LEVEL SECURITY;
DELETE FROM downgrade_notices WHERE kind = 'retention_shortened';
ALTER TABLE downgrade_notices FORCE ROW LEVEL SECURITY;

ALTER TABLE downgrade_notices DROP CONSTRAINT downgrade_notices_kind_check;
ALTER TABLE downgrade_notices
  ADD CONSTRAINT downgrade_notices_kind_check
  CHECK (kind IN ('paused', 'resumed'));

ALTER TABLE workspaces DROP COLUMN retention_purge_not_before;
