-- Reverse of 0178_portal_source_domains_policy.up.sql.
--
-- Hand-authored, NOT generated — the same precedent as 0012.down.sql: the up migration is committed generator output, the down
-- migration is the hand-written exception. Drops only the one policy; source_domains keeps ENABLE/FORCE ROW LEVEL SECURITY and its
-- ws_isolation policy (0006). With the policy gone nominara_portal reads no row of source_domains again (fail closed).

DROP POLICY IF EXISTS portal_scope_source_domains ON source_domains;
