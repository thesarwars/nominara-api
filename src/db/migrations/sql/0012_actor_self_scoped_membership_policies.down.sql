-- Reverse of 0012.up.sql.
--
-- Hand-authored, NOT generated — matches 0006.down.sql's own precedent: the
-- up migration is committed generator output, the down migration is the
-- hand-written exception. Drops only the two ADR-0001 policies; leaves
-- ENABLE/FORCE ROW LEVEL SECURITY and every ws_isolation_*/portal_scope_*
-- policy on these two tables untouched — those belong to migration 0006 and
-- are reversed only by 0006's own down migration.
--
-- Idempotency: DROP POLICY IF EXISTS is naturally idempotent — no DO-block
-- guard needed, the same as 0006.down.sql.

DROP POLICY IF EXISTS self_membership_workspaces ON workspaces;
DROP POLICY IF EXISTS self_membership_workspace_members ON workspace_members;
