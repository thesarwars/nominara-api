-- NEW-D-5 audit — security-and-tenancy.md §11: "TTL <= 4 h" belongs in the schema,
-- not only in grantSupportAccess. EXPAND phase; renumbered at merge if needed.
--
-- 1. The ceiling as a CHECK, added NOT VALID here and validated in 0086 (its own
--    transaction, per the 0051/0052 precedent). Rows written from now on are bound.
-- 2. nominara_app / nominara_worker lose blanket UPDATE on support_grants and keep
--    UPDATE (revoked_at) only: the one column revoking needs. Without this the CHECK
--    could be defeated by UPDATE ... SET created_at / expires_at.
--    INSERT stays (the ops CLI connects as nominara_app); a dedicated ops role is an
--    owner decision, not taken here.
ALTER TABLE support_grants
  ADD CONSTRAINT ck_support_ttl_max CHECK (expires_at <= created_at + interval '4 hours') NOT VALID;

REVOKE UPDATE ON support_grants FROM nominara_app, nominara_worker;
GRANT UPDATE (revoked_at) ON support_grants TO nominara_app, nominara_worker;
