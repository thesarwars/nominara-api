-- NEW-D-5 audit — undo 0085: restore the blanket UPDATE grant and drop the CHECK.
REVOKE UPDATE (revoked_at) ON support_grants FROM nominara_app, nominara_worker;
GRANT UPDATE ON support_grants TO nominara_app, nominara_worker;
ALTER TABLE support_grants DROP CONSTRAINT IF EXISTS ck_support_ttl_max;
