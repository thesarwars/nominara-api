-- STORY-170 — "Session refresh keeps the active workspace".
-- Spec: security-and-tenancy.md §5 "Session model" — "`ws` is the active
--       workspace; switching workspaces mints a new token" and §7 "a
--       [entitlement_version] mismatch forces a token refresh" (only a real
--       recovery path if refresh itself keeps the workspace it is recovering
--       for). SessionService.refresh minted `ws: null` unconditionally, so
--       every session lost tenant access on its first rotation.
--
-- sessions.active_workspace_id — additive, nullable, on the existing GLOBAL
-- sessions table (migration 0009's own comment: "a `sid` stays stable across
-- a workspace switch ... this is user identity state, not tenant data"). The
-- FK targets workspaces(id) directly (not workspace_members), matching
-- WorkspaceGuard/WorkspacesService.switchTo's own predicate
-- (membership.service.ts's isWorkspaceUsable) — the column records WHICH
-- workspace was last entered, not a live membership claim; SessionService.
-- refresh re-verifies live membership itself on every rotation rather than
-- trusting this column as an entitlement.
--
-- ON DELETE SET NULL, not CASCADE: deleting a workspace must not delete the
-- session that happened to be pointed at it — the next refresh re-verifies,
-- finds no workspace, and falls back to ws:null (the same fail-closed
-- outcome a suspended/removed-membership session gets), rather than losing
-- the session identity itself.
ALTER TABLE sessions
  ADD COLUMN active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;

COMMENT ON COLUMN sessions.active_workspace_id IS
  'The workspace POST /workspaces/{id}/switch last entered for this session (security-and-tenancy.md §5). Re-verified live (membership + workspace usability) on every /auth/refresh rather than trusted as-is; cleared to NULL there on verification failure (STORY-170).';
